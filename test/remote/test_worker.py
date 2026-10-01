"""Real local processes and temporary sandbox roots only; no Raspberry Pi access."""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import pty
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import termios
import time
import unittest
from unittest import mock
import zlib

WORKER_PATH = Path(__file__).resolve().parents[2] / "remote" / "worker.py"
spec = importlib.util.spec_from_file_location("pi_worker", WORKER_PATH)
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)
TOKEN = "1234567890abcdef"


def b64(data):
    return base64.b64encode(data).decode("ascii")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def parse_frame(raw):
    if isinstance(raw, bytes):
        raw = raw.decode("ascii")
    fields = raw.strip().split("|")
    assert len(fields) == 5 and fields[0] == "~CRC1" and fields[4].endswith("~"), raw
    body = "|".join(fields[1:4])
    assert fields[4][:-1] == "%08x" % (zlib.crc32(body.encode()) & 0xffffffff)
    return fields[1], fields[2], json.loads(base64.b64decode(fields[3]))


class WorkerCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="crc-test-")
        self.root = self.temp.name
        self.worker = w.Worker(TOKEN, output=io.StringIO(), root=self.root)
        self.sequence = 0

    def tearDown(self):
        self.worker.close()
        self.temp.cleanup()

    def request(self, op, **kwargs):
        self.sequence += 1
        return self.worker.handle(dict(id="%016x" % self.sequence, op=op, **kwargs))

    def payload(self, kind="exec", **kwargs):
        value = dict(kind=kind, root=self.root)
        if kind == "exec":
            value.update(command="printf hello", cwd="", env={}, timeoutMs=2000, maxOutputBytes=1024)
        else:
            value["path"] = "sample"
        value.update(kwargs)
        return value

    def upload(self, payload):
        raw = w.compact(payload)
        upload_id = self.request("upload_begin", byteLength=len(raw), sha256=sha(raw))["uploadId"]
        for offset in range(0, len(raw), 768):
            response = self.request("upload_chunk", uploadId=upload_id, offset=offset, data=b64(raw[offset:offset + 768]))
            self.assertNotIn("error", response)
        return self.request("upload_commit", uploadId=upload_id)

    def await_job(self, job_id, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status = self.request("job_status", jobId=job_id)
            if status.get("status") == "done":
                raw = bytearray()
                while True:
                    part = self.request("result_read", jobId=job_id, offset=len(raw), length=512)
                    self.assertEqual(len(raw), part["offset"])
                    raw.extend(base64.b64decode(part["data"]))
                    if part["eof"]:
                        break
                self.assertEqual(status["byteLength"], len(raw))
                self.assertEqual(status["sha256"], sha(raw))
                return json.loads(raw)
            time.sleep(0.01)
        self.fail("Job did not finish")

    def execute(self, payload):
        started = self.upload(payload)
        self.assertNotIn("error", started, started)
        return self.await_job(started["jobId"])

    def path(self, name="sample"):
        return Path(self.root, name)

    def assertError(self, response, code):
        self.assertEqual(response["error"]["code"], code, response)

    def test_frame_round_trip_and_crc(self):
        self.worker.emit("abcabcabcabcabca", {"data": "binary\x00☃"})
        token, request_id, data = parse_frame(self.worker.output.getvalue())
        self.assertEqual((token, request_id, data), (TOKEN, "abcabcabcabcabca", {"data": "binary\x00☃"}))

    def test_exec_stdout_stderr_binary_and_nonzero(self):
        result = self.execute(self.payload(command="printf 'a\\000\\377'; printf 'err\\001' >&2; exit 7"))
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["exitCode"], 7)
        self.assertEqual(base64.b64decode(result["stdout"]), b"a\0\xff")
        self.assertEqual(base64.b64decode(result["stderr"]), b"err\x01")
        self.assertFalse(result["stdoutTruncated"])
        self.assertFalse(result["stderrTruncated"])

    def test_exec_cwd_and_environment_sanitization(self):
        self.path("dir").mkdir()
        with mock.patch.dict(os.environ, {"CRC_TEST_SECRET": "must-not-inherit", "PYTHONPATH": "/no"}):
            result = self.execute(self.payload(command='printf "%s|%s|%s|%s" "$PWD" "$COLOR" "${CRC_TEST_SECRET-unset}" "${PYTHONPATH-unset}"',
                                               cwd="dir", env={"COLOR": "blue"}))
        self.assertEqual(base64.b64decode(result["stdout"]).decode(), self.root + "/dir|blue|unset|unset")

    def test_exec_output_bounds_are_independent(self):
        command = "head -c 3000 /dev/zero; head -c 3001 /dev/zero >&2"
        result = self.execute(self.payload(command=command))
        self.assertEqual(len(base64.b64decode(result["stdout"])), 1024)
        self.assertEqual(len(base64.b64decode(result["stderr"])), 1024)
        self.assertTrue(result["stdoutTruncated"])
        self.assertTrue(result["stderrTruncated"])

    def test_exec_timeout_kills_stubborn_process(self):
        before = time.monotonic()
        result = self.execute(self.payload(command="trap '' TERM; sleep 15", timeoutMs=100))
        self.assertEqual(result["status"], "timeout")
        self.assertLess(time.monotonic() - before, 2)
        self.assertLess(result["exitCode"], 0)

    def test_cancel_running_command(self):
        started = self.upload(self.payload(command="sleep 15"))
        self.assertEqual(self.request("cancel", jobId=started["jobId"])["status"], "cancelling")
        result = self.await_job(started["jobId"])
        self.assertEqual(result["status"], "cancelled")
        self.assertLess(result["durationMs"], 2000)
        self.assertEqual(self.request("cancel", jobId=started["jobId"])["status"], "done")

    def test_cancel_before_thread_launch_prevents_command(self):
        payload = self.payload(command="touch should-not-exist")
        job = w.Job(payload)
        job.cancel.set()
        result = w.run_exec(payload, job)
        self.assertEqual(result["status"], "cancelled")
        self.assertIsNone(result["exitCode"])
        self.assertFalse(self.path("should-not-exist").exists())

    def test_directory_fsync_failure_reports_committed_uncertainty(self):
        self.path().write_bytes(b"old")
        real_fsync = w.os.fsync
        def fail_directory_sync(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode):
                raise OSError("test failure")
            return real_fsync(fd)
        with mock.patch.object(w.os, "fsync", side_effect=fail_directory_sync):
            result = self.execute(self.payload("file_write", data=b64(b"new"), expectedSha256=sha(b"old")))
        self.assertError(result, "COMMIT_UNCERTAIN")
        self.assertEqual(self.path().read_bytes(), b"new")
        self.assertEqual([entry.name for entry in Path(self.root).iterdir()], ["sample"])

    def test_close_cancels_running_command(self):
        started = self.upload(self.payload(command="sleep 15"))
        job = self.worker.jobs[started["jobId"]]
        self.assertEqual(self.request("close"), {"status": "closed"})
        self.assertFalse(job.thread.is_alive())
        self.assertEqual(json.loads(job.result)["status"], "cancelled")
        self.assertError(self.request("job_status", jobId=started["jobId"]), "CLOSED")

    def test_single_active_exec(self):
        first = self.upload(self.payload(command="sleep 15"))
        self.assertError(self.upload(self.payload()), "BUSY")
        self.assertEqual(self.worker.uploads, {})
        self.request("cancel", jobId=first["jobId"])
        self.await_job(first["jobId"])

    def test_reject_environment_controls_and_sensitive_names(self):
        for name in ("LD_PRELOAD", "PYTHONPATH", "NODE_OPTIONS", "BASH_ENV", "ENV", "AWS_SECRET_ACCESS_KEY", "TOKEN", "authorization", "PASSWD", "DYLD_LIBRARY_PATH"):
            with self.subTest(name=name):
                with self.assertRaises(w.WorkerError) as error:
                    w.validate_payload(self.payload(env={name: "value"}))
                self.assertEqual(error.exception.code, "UNSAFE_ENV")

    def test_unknown_fields_and_invalid_payloads(self):
        invalid = [self.payload(extra=True), self.payload(timeoutMs=True), self.payload(command="\0"),
                   self.payload(timeoutMs=99), self.payload(maxOutputBytes=65537), self.payload(env={"BAD-NAME": "x"}),
                   self.payload(env={"OK": 10}), self.payload(kind="file_read", path="sample", command="wrong"),
                   {"kind": "file_write", "root": self.root, "path": "sample", "data": ""}]
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(w.WorkerError):
                w.validate_payload(payload)

    def test_root_restrictions_and_root_binding(self):
        for root in ("/", "/etc", "/etc/subdir", "/proc", "/sys", "/dev", "/boot", "/root", "relative", "/tmp/../etc", "/tmp//x"):
            with self.subTest(root=root), self.assertRaises(w.WorkerError):
                w.validate_root(root)
        self.assertError(self.upload(self.payload(root="/tmp")), "UNSAFE_ROOT")

    def test_credential_paths_rejected_by_file_tools_only(self):
        names = [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".password-store",
                 ".netrc", ".git-credentials", ".env", ".env.local", "id_rsa", "id_ed25519",
                 "credentials.json", "secrets.json"]
        for name in names:
            for path in (name, name + "/nested", "nested/" + name):
                with self.subTest(path=path), self.assertRaises(w.WorkerError) as error:
                    w.validate_payload(self.payload("file_read", path=path))
                self.assertEqual(error.exception.code, "UNSAFE_PATH")
            with self.subTest(root=name), self.assertRaises(w.WorkerError):
                w.validate_payload(self.payload("file_read", root=self.root + "/" + name))
        self.assertEqual(w.validate_payload(self.payload(cwd=".ssh"))["cwd"], ".ssh")

    def test_safe_exec_cwd_does_not_claim_to_sandbox_command(self):
        # Explicitly demonstrate the documented boundary: arbitrary shell commands
        # can leave cwd. File-operation restrictions do not sandbox the shell.
        result = self.execute(self.payload(command="cd /; printf '%s' \"$PWD\""))
        self.assertEqual(base64.b64decode(result["stdout"]), b"/")

    def test_symlink_root_ancestor_rejected(self):
        self.path("real").mkdir()
        self.path("real/child").mkdir()
        self.path("alias").symlink_to(self.path("real"), target_is_directory=True)
        with self.assertRaises(OSError):
            w.Worker(TOKEN, root=str(self.path("alias/child")))

    def test_maximum_binary_file_round_trip(self):
        content = bytes(range(256)) * 256
        self.execute(self.payload("file_write", data=b64(content), expectedSha256=None))
        result = self.execute(self.payload("file_read"))
        self.assertEqual(base64.b64decode(result["data"]), content)

    def test_request_and_result_limits_while_running(self):
        started = self.upload(self.payload(command="sleep 15"))
        self.assertError(self.request("result_read", jobId=started["jobId"], offset=0, length=513), "INVALID_ARGUMENT")
        with self.assertRaises(w.WorkerError):
            self.request("job_status", jobId=started["jobId"], extra=True)
        self.request("cancel", jobId=started["jobId"])
        self.await_job(started["jobId"])

    def test_upload_duplicate_sequential_chunks_and_checksum(self):
        data = b"123456789"
        upload = self.request("upload_begin", byteLength=len(data), sha256=sha(data))["uploadId"]
        self.assertEqual(self.request("upload_chunk", uploadId=upload, offset=0, data=b64(data[:3]))["offset"], 3)
        self.assertEqual(self.request("upload_chunk", uploadId=upload, offset=0, data=b64(data[:3]))["offset"], 3)
        self.assertError(self.request("upload_chunk", uploadId=upload, offset=0, data=b64(b"abc")), "CONFLICT")
        self.assertError(self.request("upload_chunk", uploadId=upload, offset=4, data=b64(b"4")), "CONFLICT")
        self.assertError(self.request("upload_commit", uploadId=upload), "INCOMPLETE_UPLOAD")
        self.assertNotIn(upload, self.worker.uploads)
        upload = self.request("upload_begin", byteLength=len(data), sha256=sha(data))["uploadId"]
        self.request("upload_chunk", uploadId=upload, offset=0, data=b64(data))
        self.assertError(self.request("upload_commit", uploadId=upload), "INVALID_ARGUMENT")
        self.assertNotIn(upload, self.worker.uploads)
        upload2 = self.request("upload_begin", byteLength=3, sha256=sha(b"bad"))["uploadId"]
        self.request("upload_chunk", uploadId=upload2, offset=0, data=b64(b"foo"))
        self.assertError(self.request("upload_commit", uploadId=upload2), "CHECKSUM_MISMATCH")

    def test_upload_abort_is_idempotent_and_frees_capacity(self):
        uploads = [self.request("upload_begin", byteLength=1, sha256="f" * 64)["uploadId"]
                   for _ in range(w.MAX_UPLOADS)]
        self.assertError(self.request("upload_begin", byteLength=1, sha256="f" * 64), "BUSY")
        for upload_id in uploads:
            self.assertEqual(self.request("upload_abort", uploadId=upload_id),
                             {"uploadId": upload_id, "status": "aborted"})
            self.assertEqual(self.request("upload_abort", uploadId=upload_id)["status"], "aborted")
        self.assertEqual(self.worker.uploads, {})
        self.assertIn("uploadId", self.request("upload_begin", byteLength=1, sha256="f" * 64))

    def test_failed_payload_and_scope_validation_consume_uploads(self):
        for _ in range(w.MAX_UPLOADS + 1):
            self.assertError(self.upload(self.payload(root="/tmp")), "UNSAFE_ROOT")
            self.assertEqual(self.worker.uploads, {})
            self.assertError(self.upload(self.payload(command="bad\0command")), "INVALID_ARGUMENT")
            self.assertEqual(self.worker.uploads, {})
        self.assertEqual(self.worker.jobs, {})

    def test_bad_json_commit_consumes_upload(self):
        raw = b"invalid-json"
        upload_id = self.request("upload_begin", byteLength=len(raw), sha256=sha(raw))["uploadId"]
        self.request("upload_chunk", uploadId=upload_id, offset=0, data=b64(raw))
        self.assertError(self.request("upload_commit", uploadId=upload_id), "INVALID_JSON")
        self.assertEqual(self.worker.uploads, {})
        self.assertError(self.request("upload_commit", uploadId=upload_id), "NOT_FOUND")

    def test_upload_bounds_and_expiry(self):
        self.assertError(self.request("upload_begin", byteLength=262145, sha256="f" * 64), "INVALID_ARGUMENT")
        upload = self.request("upload_begin", byteLength=1000, sha256="f" * 64)["uploadId"]
        self.assertError(self.request("upload_chunk", uploadId=upload, offset=0, data=b64(b"x" * 769)), "LIMIT_EXCEEDED")
        self.assertError(self.request("upload_chunk", uploadId=upload, offset=0, data="!!!="), "INVALID_ARGUMENT")
        self.worker.uploads[upload]["updated"] -= w.UPLOAD_SECONDS + 1
        self.assertError(self.request("upload_commit", uploadId=upload), "NOT_FOUND")
        for _ in range(w.MAX_UPLOADS):
            self.assertIn("uploadId", self.request("upload_begin", byteLength=1, sha256="f" * 64))
        self.assertError(self.request("upload_begin", byteLength=1, sha256="f" * 64), "BUSY")

    def test_duplicate_request_id_does_not_repeat_operation(self):
        request = dict(id="fedcba9876543210", op="upload_begin", byteLength=1, sha256="f" * 64)
        first = self.worker.handle(request)
        self.assertEqual(self.worker.handle(request), first)
        self.assertEqual(len(self.worker.uploads), 1)
        with self.assertRaises(w.WorkerError) as error:
            self.worker.handle(dict(request, byteLength=2))
        self.assertEqual(error.exception.code, "REQUEST_ID_CONFLICT")

    def test_retention_is_bounded_and_eviction(self):
        first = self.upload(self.payload(command="true"))["jobId"]
        self.await_job(first)
        for _ in range(w.MAX_JOBS):
            self.execute(self.payload(command="true"))
        self.assertEqual(len(self.worker.jobs), w.MAX_JOBS)
        self.assertError(self.request("job_status", jobId=first), "NOT_FOUND")
        for job in self.worker.jobs.values():
            job.last_access -= w.RETENTION_SECONDS + 1
        self.worker.cleanup_expired()
        self.assertEqual(self.worker.jobs, {})

    def completed_job_at(self, timestamp, job_id="abcdefabcdefabcd"):
        job = w.Job(self.payload())
        job.result = w.compact({"content": "x" * 1024})
        job.finished = timestamp
        job.last_access = timestamp
        self.worker.jobs[job_id] = job
        return job_id, job

    def test_active_result_reads_outlive_completion_then_expire_after_idle(self):
        job_id, job = self.completed_job_at(1000)
        with mock.patch.object(w.time, "monotonic", return_value=1299) as monotonic:
            self.assertEqual(self.request("job_status", jobId=job_id)["status"], "done")
            self.assertEqual(job.last_access, 1299)
            # A slow transfer can outlive the original completion-based deadline.
            monotonic.return_value = 1598
            first = self.request("result_read", jobId=job_id, offset=0, length=512)
            self.assertEqual(len(base64.b64decode(first["data"])), 512)
            monotonic.return_value = 1897
            second = self.request("result_read", jobId=job_id, offset=512, length=512)
            self.assertEqual(len(base64.b64decode(second["data"])), 512)
            self.assertEqual(job.finished, 1000)
            self.assertEqual(job.last_access, 1897)
            monotonic.return_value = 2196
            self.worker.cleanup_expired()
            self.assertIn(job_id, self.worker.jobs)
            monotonic.return_value = 2197
            self.assertError(self.request("job_status", jobId=job_id), "NOT_FOUND")
            self.assertEqual(self.worker.jobs, {})

    def test_absolute_result_lifetime_expires_despite_frequent_access(self):
        finished = 1000
        job_id, job = self.completed_job_at(finished)
        hard_deadline = finished + w.MAX_RESULT_LIFETIME_SECONDS
        with mock.patch.object(w.time, "monotonic", return_value=finished) as monotonic:
            for timestamp in range(finished + w.RETENTION_SECONDS - 1, hard_deadline,
                                   w.RETENTION_SECONDS - 1):
                monotonic.return_value = timestamp
                self.assertEqual(self.request("job_status", jobId=job_id)["status"], "done")
                self.assertEqual(job.last_access, timestamp)
            self.assertEqual(job.finished, finished)
            self.assertLess(hard_deadline - job.last_access, w.RETENTION_SECONDS)
            monotonic.return_value = hard_deadline
            self.assertError(self.request("result_read", jobId=job_id, offset=0, length=512), "NOT_FOUND")
            self.assertEqual(self.worker.jobs, {})

    def test_invalid_result_read_does_not_extend_idle_retention(self):
        job_id, job = self.completed_job_at(1000)
        with mock.patch.object(w.time, "monotonic", return_value=1299) as monotonic:
            self.assertError(self.request("result_read", jobId=job_id,
                                          offset=len(job.result) + 1, length=1), "INVALID_ARGUMENT")
            self.assertEqual(job.last_access, 1000)
            monotonic.return_value = 1300
            self.assertError(self.request("job_status", jobId=job_id), "NOT_FOUND")

    def test_cached_read_refreshes_only_an_unexpired_result(self):
        job_id, job = self.completed_job_at(1000)
        request = dict(id="feedfacefeedface", op="result_read", jobId=job_id, offset=0, length=512)
        with mock.patch.object(w.time, "monotonic", return_value=1299) as monotonic:
            first = self.worker.handle(request)
            monotonic.return_value = 1598
            self.assertEqual(self.worker.handle(request), first)
            self.assertEqual(job.last_access, 1598)
            self.assertEqual(job.finished, 1000)
            monotonic.return_value = 1898
            # Cached read IDs cannot retrieve old fragments after job expiry.
            self.assertError(self.worker.handle(request), "NOT_FOUND")
            self.assertNotIn(job_id, self.worker.jobs)

    def test_recent_access_does_not_change_oldest_completion_eviction(self):
        for index in range(w.MAX_JOBS):
            self.completed_job_at(1000 + index, "%016x" % (100 + index))
        first = "%016x" % 100
        with mock.patch.object(w.time, "monotonic", return_value=1100):
            self.request("job_status", jobId=first)
            self.assertEqual(self.worker.jobs[first].last_access, 1100)
            # Supply an already completed test job directly to exercise eviction
            # deterministically without running a thread under the fake clock.
            with mock.patch.object(w.threading.Thread, "start"):
                started = self.worker.start_job(self.payload())
            self.assertEqual(len(self.worker.jobs), w.MAX_JOBS)
            self.assertNotIn(first, self.worker.jobs)
            self.worker.jobs[started["jobId"]].thread = None

    def test_result_read_bounds(self):
        started = self.upload(self.payload())
        self.await_job(started["jobId"])
        self.assertError(self.request("result_read", jobId=started["jobId"], offset=0, length=513), "INVALID_ARGUMENT")
        self.assertError(self.request("result_read", jobId=started["jobId"], offset=-1, length=1), "INVALID_ARGUMENT")

    def test_file_write_read_binary_and_stat(self):
        data = b"a\0\xff\n"
        written = self.execute(self.payload("file_write", data=b64(data), expectedSha256=None))
        self.assertTrue(written["created"])
        self.assertEqual(written["sha256"], sha(data))
        self.assertEqual(stat.S_IMODE(self.path().stat().st_mode), 0o600)
        read = self.execute(self.payload("file_read"))
        self.assertEqual(base64.b64decode(read["data"]), data)
        info = self.execute(self.payload("file_stat"))
        self.assertEqual((info["type"], info["sha256"], info["byteLength"]), ("file", sha(data), len(data)))

    def test_write_hash_conflict_create_only_and_mode_preservation(self):
        self.path().write_bytes(b"old")
        self.path().chmod(0o4755)
        self.assertError(self.execute(self.payload("file_write", data=b64(b"new"), expectedSha256=None)), "CONFLICT")
        self.assertError(self.execute(self.payload("file_write", data=b64(b"new"), expectedSha256="f" * 64)), "CONFLICT")
        self.assertEqual(self.path().read_bytes(), b"old")
        result = self.execute(self.payload("file_write", data=b64(b"new"), expectedSha256=sha(b"old")))
        self.assertFalse(result["created"])
        self.assertEqual(self.path().read_bytes(), b"new")
        self.assertEqual(stat.S_IMODE(self.path().stat().st_mode), 0o755)
        self.assertError(self.execute(self.payload("file_write", path="missing", data="", expectedSha256=sha(b""))), "CONFLICT")
        self.execute(self.payload("file_write", path="created", data="", expectedSha256=None, mode=0o644))
        self.assertEqual(stat.S_IMODE(self.path("created").stat().st_mode), 0o644)

    def test_explicit_mode_is_rejected_for_replacement(self):
        self.path().write_bytes(b"old")
        self.path().chmod(0o755)
        for mode in (0o600, 0o644):
            with self.subTest(mode=mode):
                response = self.upload(self.payload("file_write", data=b64(b"new"),
                                                    expectedSha256=sha(b"old"), mode=mode))
                self.assertError(response, "MODE_CREATE_ONLY")
                self.assertEqual(self.path().read_bytes(), b"old")
                self.assertEqual(stat.S_IMODE(self.path().stat().st_mode), 0o755)
        self.assertEqual(self.worker.jobs, {})
        self.assertEqual(self.worker.uploads, {})

    def test_atomic_write_failure_keeps_original_and_removes_temporary(self):
        self.path().write_bytes(b"old")
        payload = self.payload("file_write", data=b64(b"new"), expectedSha256=sha(b"old"))
        with mock.patch.object(w.os, "replace", side_effect=OSError("private error data")):
            result = self.execute(payload)
        self.assertError(result, "IO_ERROR")
        self.assertNotIn("private", json.dumps(result))
        self.assertEqual(self.path().read_bytes(), b"old")
        self.assertEqual([entry.name for entry in Path(self.root).iterdir()], ["sample"])

    def test_create_only_cannot_clobber_concurrent_creation(self):
        real_link = w.os.link
        def racing_link(source, target, **kwargs):
            self.path().write_bytes(b"racer")
            return real_link(source, target, **kwargs)
        with mock.patch.object(w.os, "link", side_effect=racing_link):
            result = self.execute(self.payload("file_write", data=b64(b"ours"), expectedSha256=None))
        self.assertError(result, "CONFLICT")
        self.assertEqual(self.path().read_bytes(), b"racer")
        self.assertEqual([entry.name for entry in Path(self.root).iterdir()], ["sample"])

    def test_replace_checks_for_concurrent_file_change(self):
        self.path().write_bytes(b"old")
        original_fsync = w.os.fsync
        changed = False
        def racing_fsync(fd):
            nonlocal changed
            if not changed:
                self.path().write_bytes(b"racer")
                changed = True
            return original_fsync(fd)
        with mock.patch.object(w.os, "fsync", side_effect=racing_fsync):
            result = self.execute(self.payload("file_write", data=b64(b"ours"), expectedSha256=sha(b"old")))
        self.assertError(result, "CONFLICT")
        self.assertEqual(self.path().read_bytes(), b"racer")

    def test_path_traversal_and_symlink_traps(self):
        for path in ("/etc/passwd", "../outside", "a/../sample", "a//sample", "a/./sample", ""):
            with self.subTest(path=path), self.assertRaises(w.WorkerError):
                w.validate_payload(self.payload("file_read", path=path))
        with tempfile.TemporaryDirectory(prefix="crc-outside-") as outside:
            target = Path(outside, "secret")
            target.write_bytes(b"outside")
            self.path("link").symlink_to(outside, target_is_directory=True)
            self.path("sample").symlink_to(target)
            for payload in (self.payload("file_read"), self.payload("file_read", path="link/secret"),
                            self.payload("file_write", data=b64(b"overwrite"), expectedSha256=sha(b"outside")),
                            self.payload("exec", cwd="link")):
                with self.subTest(kind=payload["kind"], path=payload.get("path")):
                    self.assertIn("error", self.execute(payload))
            self.assertEqual(target.read_bytes(), b"outside")
            with self.assertRaises(OSError):
                w.Worker(TOKEN, root=str(self.path("link")))

    def test_atomic_replace_never_follows_raced_symlink(self):
        self.path().write_bytes(b"old")
        with tempfile.TemporaryDirectory(prefix="crc-outside-") as outside:
            target = Path(outside, "secret")
            target.write_bytes(b"outside")
            real_replace = w.os.replace
            def replace_after_symlink(source, name, **kwargs):
                self.path().unlink()
                self.path().symlink_to(target)
                return real_replace(source, name, **kwargs)
            with mock.patch.object(w.os, "replace", side_effect=replace_after_symlink):
                result = self.execute(self.payload("file_write", data=b64(b"ours"), expectedSha256=sha(b"old")))
            self.assertNotIn("error", result)
            self.assertEqual(target.read_bytes(), b"outside")
            self.assertFalse(self.path().is_symlink())
            self.assertEqual(self.path().read_bytes(), b"ours")

    def test_nonregular_files_rejected_without_blocking(self):
        os.mkfifo(self.path())
        before = time.monotonic()
        self.assertError(self.execute(self.payload("file_read")), "UNSAFE_PATH")
        self.assertLess(time.monotonic() - before, 1)

    def test_large_files_and_content_bounds(self):
        self.path().write_bytes(b"x" * 65537)
        self.assertError(self.execute(self.payload("file_read")), "FILE_TOO_LARGE")
        info = self.execute(self.payload("file_stat"))
        self.assertIsNone(info["sha256"])
        with self.assertRaises(w.WorkerError):
            w.validate_payload(self.payload("file_write", data=b64(b"x" * 65537), expectedSha256=None))

    def test_list_cap_and_symlink_metadata(self):
        self.path("z").write_bytes(b"z")
        self.path("a").mkdir()
        self.path("link").symlink_to("z")
        result = self.execute(self.payload("file_list", path="", limit=3))
        self.assertFalse(result["truncated"])
        self.assertEqual([item["name"] for item in result["entries"]], ["a", "link", "z"])
        self.assertEqual(result["entries"][1]["type"], "symlink")
        self.assertTrue(self.execute(self.payload("file_list", path="", limit=2))["truncated"])
        self.assertEqual(self.execute(self.payload("file_stat", path=""))["type"], "directory")

    def test_list_1000_entry_hard_limit(self):
        for i in range(1001):
            self.path("f%04d" % i).touch()
        result = self.execute(self.payload("file_list", path=""))
        self.assertEqual(len(result["entries"]), 1000)
        self.assertTrue(result["truncated"])

    def test_unified_diff_and_missing_file(self):
        self.path().write_bytes(b"old\nkeep\n")
        result = self.execute(self.payload("file_diff", data=b64(b"new\nkeep\n")))
        self.assertIn("-old", result["diff"])
        self.assertIn("+new", result["diff"])
        self.assertTrue(result["changed"])
        self.assertFalse(result["truncated"])
        self.assertEqual(self.path().read_bytes(), b"old\nkeep\n")
        unchanged = self.execute(self.payload("file_diff", data=b64(b"old\nkeep\n")))
        self.assertEqual(unchanged["diff"], "")
        self.assertFalse(unchanged["changed"])
        missing = self.execute(self.payload("file_diff", path="new", data=b64(b"new\n")))
        self.assertIn("--- /dev/null", missing["diff"])
        self.assertFalse(missing["exists"])
        self.assertFalse(self.path("new").exists())

    def test_diff_binary_rejected_and_output_bounded(self):
        self.path().write_bytes(b"\xff")
        self.assertError(self.execute(self.payload("file_diff", data="")), "BINARY_FILE")
        self.path().write_bytes(b"a\n" * 2000)
        result = self.execute(self.payload("file_diff", data=b64(b"b\n" * 2000), maxOutputBytes=1024))
        self.assertLessEqual(len(result["diff"].encode()), 1024)
        self.assertTrue(result["truncated"])


class ProcessProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="crc-protocol-")
        self.root = self.temp.name

    def tearDown(self):
        self.temp.cleanup()

    def spawn(self, **kwargs):
        return subprocess.Popen([sys.executable, str(WORKER_PATH), TOKEN, self.root], **kwargs)

    def test_cli_ready_close_and_malformed_line_frames(self):
        lines = [b"not-json\n", b"x" * 3000 + b"\n", b'{"id":"0000000000000001","op":"nope","op":"close"}\n',
                 b'{"id":"0000000000000002","op":"close"}\n']
        process = self.spawn(stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        stdout, stderr = process.communicate(b"".join(lines), timeout=5)
        self.assertEqual(process.returncode, 0)
        self.assertEqual(stderr, b"")
        frames = [parse_frame(line) for line in stdout.splitlines()]
        self.assertEqual(len(frames), 5)
        self.assertEqual(frames[0][1], "0" * 16)
        self.assertEqual(frames[0][2]["status"], "ready")
        self.assertEqual(frames[0][2]["root"], self.root)
        self.assertRegex(frames[0][2]["python"], r"^3\.\d+\.\d+$")
        self.assertEqual(frames[1][2]["error"]["code"], "INVALID_JSON")
        self.assertEqual(frames[2][2]["error"]["code"], "LIMIT_EXCEEDED")
        self.assertEqual(frames[3][2]["error"]["code"], "INVALID_JSON")
        self.assertEqual(frames[4][2], {"status": "closed"})

    def test_cli_actual_rpc_upload_exec_result(self):
        process = self.spawn(stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.assertEqual(parse_frame(process.stdout.readline())[2]["status"], "ready")
            sequence = 0
            def rpc(op, **kwargs):
                nonlocal sequence
                sequence += 1
                request = dict(id="%016x" % sequence, op=op, **kwargs)
                process.stdin.write(w.compact(request) + b"\n")
                process.stdin.flush()
                token, request_id, response = parse_frame(process.stdout.readline())
                self.assertEqual(token, TOKEN)
                self.assertEqual(request_id, request["id"])
                return response
            payload = dict(kind="exec", root=self.root, command="printf rpc; printf error >&2; exit 2",
                           cwd="", env={}, timeoutMs=1000, maxOutputBytes=1024)
            raw = w.compact(payload)
            upload = rpc("upload_begin", byteLength=len(raw), sha256=sha(raw))["uploadId"]
            rpc("upload_chunk", uploadId=upload, offset=0, data=b64(raw))
            job = rpc("upload_commit", uploadId=upload)["jobId"]
            for _ in range(100):
                status = rpc("job_status", jobId=job)
                if status["status"] == "done":
                    break
                time.sleep(0.01)
            self.assertEqual(status["status"], "done")
            result_raw = base64.b64decode(rpc("result_read", jobId=job, offset=0, length=512)["data"])
            self.assertEqual(sha(result_raw), status["sha256"])
            result = json.loads(result_raw)
            self.assertEqual(result["exitCode"], 2)
            self.assertEqual(base64.b64decode(result["stdout"]), b"rpc")
            self.assertEqual(base64.b64decode(result["stderr"]), b"error")
            self.assertEqual(rpc("close"), {"status": "closed"})
            process.wait(timeout=3)
            self.assertEqual(process.stderr.read(), b"")
        finally:
            process.kill() if process.poll() is None else None
            process.communicate()

    def test_eof_cancels_active_exec_before_delayed_side_effect(self):
        process = self.spawn(stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.assertEqual(parse_frame(process.stdout.readline())[2]["status"], "ready")
            payload = dict(kind="exec", root=self.root, command="sleep 0.5; touch unexpected",
                           cwd="", env={}, timeoutMs=2000, maxOutputBytes=1024)
            raw = w.compact(payload)
            def rpc(request):
                process.stdin.write(w.compact(request) + b"\n")
                process.stdin.flush()
                return parse_frame(process.stdout.readline())[2]
            upload = rpc(dict(id="0000000000000001", op="upload_begin", byteLength=len(raw), sha256=sha(raw)))["uploadId"]
            rpc(dict(id="0000000000000002", op="upload_chunk", uploadId=upload, offset=0, data=b64(raw)))
            rpc(dict(id="0000000000000003", op="upload_commit", uploadId=upload))
            process.stdin.close()
            process.stdin = None
            process.wait(timeout=3)
            self.assertEqual(process.returncode, 0)
            time.sleep(0.6)
            self.assertFalse(Path(self.root, "unexpected").exists())
            self.assertEqual(process.stderr.read(), b"")
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate()

    def test_invalid_startup_root_returns_safe_error(self):
        result = subprocess.run([sys.executable, str(WORKER_PATH), TOKEN, "/etc"], capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(parse_frame(result.stdout)[2]["error"]["code"], "UNSAFE_ROOT")
        self.assertEqual(result.stderr, b"")

    def test_credential_startup_root_rejected_before_ready(self):
        for name in (".ssh", ".aws", ".env.local"):
            root = Path(self.root, name)
            root.mkdir()
            with self.subTest(root=name):
                result = subprocess.run([sys.executable, str(WORKER_PATH), TOKEN, str(root)],
                                        capture_output=True, timeout=3)
                self.assertEqual(result.returncode, 2)
                frames = [parse_frame(line)[2] for line in result.stdout.splitlines()]
                self.assertEqual(len(frames), 1)
                self.assertEqual(frames[0]["error"]["code"], "UNSAFE_PATH")
                self.assertNotIn("status", frames[0])
                self.assertEqual(result.stderr, b"")

    def test_tty_echo_is_disabled_then_restored_on_close_and_signal(self):
        for how in ("close", "signal", "interrupt"):
            with self.subTest(how=how):
                master, slave = pty.openpty()
                original = termios.tcgetattr(slave)
                process = self.spawn(stdin=slave, stdout=slave, stderr=subprocess.PIPE)
                try:
                    selector = selectors.DefaultSelector()
                    selector.register(master, selectors.EVENT_READ)
                    ready = b""
                    deadline = time.monotonic() + 3
                    while b"\n" not in ready and time.monotonic() < deadline:
                        if selector.select(timeout=0.1):
                            ready += os.read(master, 4096)
                    selector.close()
                    self.assertEqual(parse_frame(ready)[2]["status"], "ready")
                    self.assertFalse(termios.tcgetattr(slave)[3] & termios.ECHO)
                    if how == "close":
                        os.write(master, b'{"id":"0000000000000001","op":"close"}\n')
                    else:
                        process.send_signal(signal.SIGTERM if how == "signal" else signal.SIGINT)
                    process.wait(timeout=4)
                    self.assertEqual(termios.tcgetattr(slave), original)
                    self.assertEqual(process.stderr.read(), b"")
                finally:
                    if process.poll() is None:
                        process.kill()
                    process.communicate()
                    os.close(master)
                    os.close(slave)


if __name__ == "__main__":
    unittest.main()
