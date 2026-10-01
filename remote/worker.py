#!/usr/bin/env python3
"""Ephemeral Raspberry Pi Connect terminal worker (Python 3 standard library).

This is a foreground process, not a service. It restores terminal echo and kills
its active process groups on close, EOF, or a handled termination signal. It
never installs itself or opens a socket. Commands are arbitrary /bin/sh commands
running with the signed-in user's privileges: root/cwd validation IS NOT an
execution sandbox. File operations use descriptor-relative, no-follow access.

Frames: ~CRC1|session|request|base64(compact JSON)|crc32~\n
CRC32 covers the ASCII session|request|base64 fields, not the delimiters. CRCs
are error detection, not authentication. File-write hashes are optimistic
preconditions; unrelated writers must coordinate to avoid concurrent updates.
"""

import base64
import binascii
import collections
import difflib
import hashlib
import json
import os
import re
import secrets
import selectors
import signal
import stat
import subprocess
import sys
import termios
import threading
import time
import zlib

MAX_INPUT = 2048
MAX_UPLOAD = 262144
MAX_CHUNK = 768
MAX_FILE = 65536
MAX_RESULT = 524288
MAX_UPLOADS = 4
MAX_JOBS = 8
RETENTION_SECONDS = 300
MAX_RESULT_LIFETIME_SECONDS = 3600
UPLOAD_SECONDS = 120
TERM_GRACE_SECONDS = 0.35
ID_RE = re.compile(r"^[a-f0-9]{16}$")
HASH_RE = re.compile(r"^[a-f0-9]{64}$")
FORBIDDEN_ROOTS = ("/etc", "/proc", "/sys", "/dev", "/boot", "/root")
BASE_ENV = ("HOME", "USER", "LOGNAME", "PATH", "LANG")
CREDENTIAL_NAMES = {".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker",
                    ".password-store", ".netrc", ".git-credentials", "id_rsa",
                    "id_ed25519", "credentials.json", "secrets.json"}
DANGEROUS_ENV = {"ENV", "BASH_ENV", "SHELLOPTS", "BASHOPTS", "CDPATH", "IFS",
                 "GLOBIGNORE", "PS4", "PROMPT_COMMAND", "PERL5OPT", "PERL5LIB",
                 "RUBYOPT", "NODE_OPTIONS", "NODE_PATH", "GCONV_PATH",
                 "GLIBC_TUNABLES", "LIBPATH", "SHLIB_PATH"}


class WorkerError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def fail(code, message):
    raise WorkerError(code, message)


def error_result(exc):
    if isinstance(exc, WorkerError):
        return {"error": {"code": exc.code, "message": exc.message}}
    if isinstance(exc, FileNotFoundError):
        return {"error": {"code": "NOT_FOUND", "message": "Path does not exist"}}
    if isinstance(exc, PermissionError):
        return {"error": {"code": "PERMISSION_DENIED", "message": "Filesystem access denied"}}
    if isinstance(exc, OSError):
        return {"error": {"code": "IO_ERROR", "message": "Filesystem or process operation failed"}}
    return {"error": {"code": "INTERNAL_ERROR", "message": "Operation failed"}}


def compact(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True,
                      allow_nan=False).encode("ascii")


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                fail("INVALID_JSON", "Duplicate JSON field")
            result[key] = value
        return result

    def constant(_):
        fail("INVALID_JSON", "Non-finite JSON number")

    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs,
                          parse_constant=constant)
    except (ValueError, UnicodeError, RecursionError):
        fail("INVALID_JSON", "Invalid JSON")


def fields(value, required, optional=()):
    if not isinstance(value, dict) or not set(required).issubset(value):
        fail("INVALID_ARGUMENT", "Missing or invalid fields")
    if set(value) - set(required) - set(optional):
        fail("INVALID_ARGUMENT", "Unknown field")


def integer(value, low, high):
    if type(value) is not int or not low <= value <= high:
        fail("INVALID_ARGUMENT", "Integer outside allowed range")
    return value


def string(value, maximum, allow_empty=False):
    if not isinstance(value, str) or "\0" in value or (not value and not allow_empty):
        fail("INVALID_ARGUMENT", "Invalid string")
    try:
        size = len(value.encode("utf-8"))
    except UnicodeError:
        fail("INVALID_ARGUMENT", "Invalid Unicode string")
    if size > maximum:
        fail("LIMIT_EXCEEDED", "String exceeds byte limit")
    return value


def identifier(value):
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        fail("INVALID_ARGUMENT", "Invalid identifier")
    return value


def digest(value):
    if not isinstance(value, str) or not HASH_RE.fullmatch(value):
        fail("INVALID_ARGUMENT", "Invalid SHA-256")
    return value


def decode_data(value, maximum):
    if not isinstance(value, str) or len(value) > ((maximum + 2) // 3) * 4:
        fail("LIMIT_EXCEEDED", "Base64 data exceeds limit")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        fail("INVALID_ARGUMENT", "Invalid base64 data")
    if len(decoded) > maximum or base64.b64encode(decoded).decode("ascii") != value:
        fail("INVALID_ARGUMENT", "Invalid or oversized base64 data")
    return decoded


def relative_parts(path, allow_root=False):
    string(path, 4096, allow_empty=allow_root)
    if path in ("", ".") and allow_root:
        return []
    if path.startswith("/") or any(p in ("", ".", "..") for p in path.split("/")):
        fail("UNSAFE_PATH", "Expected a root-relative path without traversal")
    return path.split("/")


def validate_root(root):
    string(root, 4096)
    if not root.startswith("/") or root == "/":
        fail("UNSAFE_ROOT", "An absolute, non-system root is required")
    parts = root[1:].split("/")
    if any(p in ("", ".", "..") for p in parts):
        fail("UNSAFE_ROOT", "Root must be canonical without traversal")
    if any(root == p or root.startswith(p + "/") for p in FORBIDDEN_ROOTS):
        fail("UNSAFE_ROOT", "System roots are not permitted")
    return parts


def validate_file_scope(root, path):
    for part in validate_root(root) + relative_parts(path, allow_root=True):
        lower = part.lower()
        if lower in CREDENTIAL_NAMES or lower == ".env" or lower.startswith(".env."):
            fail("UNSAFE_PATH", "Credential and secret paths are not permitted by file tools")


def open_directory(root, parts=()):
    """Open every root/path component O_NOFOLLOW, pinning each directory."""
    root_parts = validate_root(root)
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.open("/", flags)
    try:
        for name in list(root_parts) + list(parts):
            nxt = os.open(name, flags, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def open_regular(parent, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                 dir_fd=parent)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            fail("UNSAFE_PATH", "A regular file is required")
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_regular(parent, name):
    fd = open_regular(parent, name)
    try:
        info = os.fstat(fd)
        if info.st_size > MAX_FILE:
            fail("FILE_TOO_LARGE", "File exceeds 64 KiB limit")
        chunks = []
        remaining = MAX_FILE + 1
        while remaining:
            block = os.read(fd, min(16384, remaining))
            if not block:
                break
            chunks.append(block)
            remaining -= len(block)
        data = b"".join(chunks)
        if len(data) > MAX_FILE:
            fail("FILE_TOO_LARGE", "File exceeds 64 KiB limit")
        after = os.fstat(fd)
        if (info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (
                after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            fail("CONFLICT", "File changed while reading")
        return data, after
    finally:
        os.close(fd)


def validate_payload(payload):
    fields(payload, ("kind", "root"), ("command", "cwd", "env", "timeoutMs",
           "maxOutputBytes", "path", "limit", "data", "expectedSha256", "mode"))
    kind = payload["kind"]
    validate_root(payload["root"])
    if kind == "exec":
        fields(payload, ("kind", "root", "command", "cwd", "env", "timeoutMs", "maxOutputBytes"))
        string(payload["command"], 16384)
        relative_parts(payload["cwd"], allow_root=True)
        integer(payload["timeoutMs"], 100, 120000)
        integer(payload["maxOutputBytes"], 1024, 65536)
        env = payload["env"]
        if not isinstance(env, dict) or len(env) > 64:
            fail("INVALID_ARGUMENT", "Invalid environment overrides")
        size = 0
        for name, value in env.items():
            if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", name):
                fail("INVALID_ARGUMENT", "Invalid environment variable name")
            upper = name.upper()
            if (upper.startswith(("LD_", "DYLD_", "PYTHON")) or upper in DANGEROUS_ENV
                    or any(term in upper for term in ("SECRET", "PASSWORD", "PASSWD", "TOKEN", "KEY", "AUTH", "CREDENTIAL"))):
                fail("UNSAFE_ENV", "Sensitive or interpreter-control environment override rejected")
            string(value, 4096, allow_empty=True)
            size += len(name.encode()) + len(value.encode())
        if size > 16384:
            fail("LIMIT_EXCEEDED", "Environment exceeds byte limit")
    elif kind in ("file_list", "file_stat", "file_read", "file_write", "file_diff"):
        required = ["kind", "root", "path"]
        optional = []
        if kind == "file_list":
            optional = ["limit"]
            integer(payload.get("limit", 1000), 1, 1000)
        elif kind == "file_write":
            required += ["data", "expectedSha256"]
            optional = ["mode"]
            if payload.get("expectedSha256") is not None:
                digest(payload["expectedSha256"])
            if "mode" in payload and (type(payload["mode"]) is not int or payload["mode"] not in (0o600, 0o644)):
                fail("INVALID_ARGUMENT", "New-file mode must be 0600 or 0644")
            if "mode" in payload and payload.get("expectedSha256") is not None:
                fail("MODE_CREATE_ONLY", "Explicit mode is only supported when creating a new file")
        elif kind == "file_diff":
            required += ["data"]
            optional = ["maxOutputBytes"]
            integer(payload.get("maxOutputBytes", 65536), 1024, 65536)
        fields(payload, required, optional)
        relative_parts(payload["path"], allow_root=kind in ("file_list", "file_stat"))
        validate_file_scope(payload["root"], payload["path"])
        if kind in ("file_write", "file_diff"):
            decode_data(payload["data"], MAX_FILE)
    else:
        fail("INVALID_ARGUMENT", "Unknown operation kind")
    return payload


def type_name(mode):
    if stat.S_ISREG(mode):
        return "file"
    if stat.S_ISDIR(mode):
        return "directory"
    if stat.S_ISLNK(mode):
        return "symlink"
    return "other"


def stat_result(info):
    return {"type": type_name(info.st_mode), "byteLength": info.st_size,
            "mode": stat.S_IMODE(info.st_mode), "mtimeNs": str(info.st_mtime_ns)}


def file_operation(payload):
    kind, root, path = payload["kind"], payload["root"], payload["path"]
    validate_file_scope(root, path)
    parts = relative_parts(path, allow_root=kind in ("file_list", "file_stat"))
    output = {"kind": kind, "path": path}
    if kind == "file_list":
        fd = open_directory(root, parts)
        try:
            entries = []
            result_size = len(compact(output)) + 128
            limit = payload.get("limit", 1000)
            truncated = False
            with os.scandir(fd) as iterator:
                for entry in iterator:
                    if len(entries) == limit:
                        truncated = True
                        break
                    info = entry.stat(follow_symlinks=False)
                    record = dict(name=entry.name, **stat_result(info))
                    result_size += len(compact(record)) + 1
                    if result_size > MAX_RESULT:
                        truncated = True
                        break
                    entries.append(record)
            entries.sort(key=lambda item: item["name"])
            return dict(output, entries=entries, truncated=truncated)
        finally:
            os.close(fd)
    parent = open_directory(root, parts[:-1])
    try:
        name = parts[-1] if parts else None
        if kind == "file_stat":
            info = os.stat(name, dir_fd=parent, follow_symlinks=False) if name else os.fstat(parent)
            if stat.S_ISLNK(info.st_mode):
                fail("UNSAFE_PATH", "Symlinks are not permitted")
            sha = None
            if stat.S_ISREG(info.st_mode) and info.st_size <= MAX_FILE:
                content, info = read_regular(parent, name)
                sha = hashlib.sha256(content).hexdigest()
            return dict(output, **stat_result(info), sha256=sha)
        if kind == "file_read":
            content, _ = read_regular(parent, name)
            return dict(output, data=base64.b64encode(content).decode("ascii"),
                        byteLength=len(content), sha256=hashlib.sha256(content).hexdigest())
        proposed = decode_data(payload["data"], MAX_FILE)
        if kind == "file_diff":
            try:
                current, _ = read_regular(parent, name)
                exists = True
            except FileNotFoundError:
                current, exists = b"", False
            try:
                old_text, new_text = current.decode("utf-8"), proposed.decode("utf-8")
            except UnicodeError:
                fail("BINARY_FILE", "Unified diff requires UTF-8 text")
            if "\0" in old_text or "\0" in new_text:
                fail("BINARY_FILE", "Unified diff requires text without NUL bytes")
            chunks = []
            size = 0
            truncated = False
            maximum = payload.get("maxOutputBytes", 65536)
            for line in difflib.unified_diff(old_text.splitlines(True), new_text.splitlines(True),
                                             fromfile=path if exists else "/dev/null", tofile=path):
                raw = line.encode("utf-8")
                available = maximum - size
                chunks.append(raw[:available])
                size += min(len(raw), available)
                if len(raw) > available:
                    truncated = True
                    break
            text = b"".join(chunks).decode("utf-8", errors="ignore")
            return dict(output, diff=text, truncated=truncated, changed=current != proposed,
                        exists=exists, sha256=hashlib.sha256(current).hexdigest() if exists else None)
        return dict(output, **atomic_write(parent, name, proposed, payload["expectedSha256"],
                                           payload.get("mode", 0o600)))
    finally:
        os.close(parent)


def atomic_write(parent, name, content, expected, new_mode):
    original = None
    try:
        current, original = read_regular(parent, name)
    except FileNotFoundError:
        if expected is not None:
            fail("CONFLICT", "Expected an existing file")
    else:
        if expected is None or hashlib.sha256(current).hexdigest() != expected:
            fail("CONFLICT", "File hash precondition failed")
    temporary = ".crc-write-" + secrets.token_hex(12)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                 0o600, dir_fd=parent)
    try:
        try:
            offset = 0
            while offset < len(content):
                offset += os.write(fd, content[offset:])
            # Preserve ordinary permissions, including executable bits, never set-ID/sticky bits.
            mode = (stat.S_IMODE(original.st_mode) & 0o777) if original else new_mode
            os.fchmod(fd, mode)
            os.fsync(fd)
        finally:
            os.close(fd)
        if original:
            # Recheck immediately before replacing. This is an optimistic precondition,
            # not a lock on unrelated writers; dir_fd prevents symlink traversal.
            latest, info = read_regular(parent, name)
            if (info.st_dev, info.st_ino) != (original.st_dev, original.st_ino) or hashlib.sha256(latest).hexdigest() != expected:
                fail("CONFLICT", "File changed before replacement")
            os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
        else:
            # Atomic no-clobber create: rename would overwrite a concurrent creator.
            try:
                os.link(temporary, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
            except FileExistsError:
                fail("CONFLICT", "File was created concurrently")
            os.unlink(temporary, dir_fd=parent)
        try:
            os.fsync(parent)
        except OSError:
            fail("COMMIT_UNCERTAIN", "File was replaced but durability could not be confirmed")
        return {"byteLength": len(content), "sha256": hashlib.sha256(content).hexdigest(),
                "created": original is None, "mode": mode}
    finally:
        try:
            os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError:
            pass


class Job:
    def __init__(self, payload):
        self.payload = payload
        self.cancel = threading.Event()
        self.thread = None
        self.result = None
        self.finished = None
        self.last_access = None
        self.process = None


def kill_group(process, sig):
    try:
        os.killpg(process.pid, sig)
    except ProcessLookupError:
        pass


def run_exec(payload, job):
    start = time.monotonic()
    if job.cancel.is_set():
        return {"kind": "exec", "status": "cancelled", "exitCode": None,
                "stdout": "", "stderr": "", "stdoutTruncated": False,
                "stderrTruncated": False, "durationMs": 0}
    env = {name: value for name, value in os.environ.items() if name in BASE_ENV}
    env.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin")
    env.update(payload["env"])
    directory = open_directory(payload["root"], relative_parts(payload["cwd"], allow_root=True))
    try:
        process = subprocess.Popen(["/bin/sh", "-c", payload["command"]],
                                   cwd="/proc/self/fd/%d" % directory, pass_fds=(directory,),
                                   env=env, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   start_new_session=True)
    finally:
        os.close(directory)
    job.process = process
    captures = {"stdout": bytearray(), "stderr": bytearray()}
    truncated = {"stdout": False, "stderr": False}
    maximum = payload["maxOutputBytes"]
    deadline = start + payload["timeoutMs"] / 1000.0
    stop_at = None
    killed_at = None
    reason = "completed"
    selector = selectors.DefaultSelector()
    try:
        for name in ("stdout", "stderr"):
            stream = getattr(process, name)
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        while selector.get_map() or process.poll() is None:
            now = time.monotonic()
            if stop_at is None and (job.cancel.is_set() or now >= deadline):
                reason = "cancelled" if job.cancel.is_set() else "timeout"
                stop_at = now
                kill_group(process, signal.SIGTERM)
            if stop_at is not None and killed_at is None and now - stop_at >= TERM_GRACE_SECONDS:
                kill_group(process, signal.SIGKILL)
                killed_at = now
            # Even a child that deliberately escaped the group cannot hold our pipes forever.
            if killed_at is not None and now - killed_at >= TERM_GRACE_SECONDS:
                break
            for key, _ in selector.select(timeout=0.025):
                try:
                    chunk = os.read(key.fileobj.fileno(), 16384)
                except BlockingIOError:
                    continue
                if not chunk:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                name = key.data
                available = maximum - len(captures[name])
                captures[name].extend(chunk[:available])
                truncated[name] |= len(chunk) > available
        # Remove same-group background processes even if the shell already exited.
        kill_group(process, signal.SIGKILL)
        process.wait(timeout=1)
    finally:
        selector.close()
        kill_group(process, signal.SIGKILL)
        for stream in (process.stdout, process.stderr):
            stream.close()
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass
        job.process = None
    return {"kind": "exec", "status": reason, "exitCode": process.returncode,
            "stdout": base64.b64encode(captures["stdout"]).decode("ascii"),
            "stderr": base64.b64encode(captures["stderr"]).decode("ascii"),
            "stdoutTruncated": truncated["stdout"], "stderrTruncated": truncated["stderr"],
            "durationMs": int((time.monotonic() - start) * 1000)}


class Worker:
    def __init__(self, session, output=None, root=None):
        self.session = identifier(session)
        self.root = root
        if root is not None:
            validate_file_scope(root, "")
            fd = open_directory(root)
            os.close(fd)
        self.output = output if output is not None else sys.stdout
        self.output_lock = threading.Lock()
        self.lock = threading.RLock()
        self.file_lock = threading.Lock()
        self.uploads = {}
        self.jobs = {}
        self.responses = collections.OrderedDict()
        self.closed = False

    def emit(self, request_id, response):
        encoded = base64.b64encode(compact(response)).decode("ascii")
        body = "%s|%s|%s" % (self.session, request_id, encoded)
        crc = "%08x" % (zlib.crc32(body.encode("ascii")) & 0xffffffff)
        with self.output_lock:
            self.output.write("~CRC1|%s|%s~\n" % (body, crc))
            self.output.flush()

    def cleanup_expired(self):
        now = time.monotonic()
        with self.lock:
            self.uploads = {key: value for key, value in self.uploads.items()
                            if now - value["updated"] < UPLOAD_SECONDS}
            self.jobs = {key: value for key, value in self.jobs.items()
                         if value.finished is None or (
                             now - value.last_access < RETENTION_SECONDS and
                             now - value.finished < MAX_RESULT_LIFETIME_SECONDS)}

    def refresh_result_access(self, request, response):
        # Keep a slow, active terminal transfer alive without changing completion
        # order for bounded-cache eviction. Errors and running polls do not extend it.
        if ((request["op"] == "job_status" and response.get("status") == "done") or
                (request["op"] == "result_read" and "data" in response)):
            with self.lock:
                job = self.jobs.get(request.get("jobId"))
                if job is not None and job.result is not None:
                    job.last_access = time.monotonic()

    def handle(self, request):
        fields(request, ("id", "op"), ("byteLength", "sha256", "uploadId", "offset", "data", "jobId", "length"))
        request_id = identifier(request["id"])
        if request_id == "0000000000000000":
            fail("INVALID_ARGUMENT", "Reserved request identifier")
        signature = hashlib.sha256(compact(request)).digest()
        self.cleanup_expired()
        if request_id in self.responses:
            old_signature, response = self.responses[request_id]
            if old_signature != signature:
                fail("REQUEST_ID_CONFLICT", "Request identifier was already used")
            if (request["op"] in ("job_status", "result_read") and
                    request.get("jobId") not in self.jobs):
                # Read-only replay must not expose an expired result fragment.
                # Keep the signature so reusing this ID for a mutation still fails.
                response = {"error": {"code": "NOT_FOUND", "message": "Job is missing or expired"}}
                self.responses[request_id] = (old_signature, response)
                return response
            self.refresh_result_access(request, response)
            return response
        try:
            if self.closed:
                fail("CLOSED", "Worker is closed")
            response = self.dispatch(request)
        except Exception as exc:
            response = error_result(exc)
        self.refresh_result_access(request, response)
        self.responses[request_id] = (signature, response)
        while len(self.responses) > 256:
            self.responses.popitem(last=False)
        return response

    def dispatch(self, request):
        op = request["op"]
        common = ("id", "op")
        if op == "upload_begin":
            fields(request, common + ("byteLength", "sha256"))
            length = integer(request["byteLength"], 1, MAX_UPLOAD)
            sha = digest(request["sha256"])
            if len(self.uploads) >= MAX_UPLOADS:
                fail("BUSY", "Too many pending uploads")
            upload_id = secrets.token_hex(8)
            self.uploads[upload_id] = {"length": length, "sha256": sha, "data": bytearray(),
                                       "updated": time.monotonic()}
            return {"uploadId": upload_id}
        if op == "upload_abort":
            fields(request, common + ("uploadId",))
            upload_id = identifier(request["uploadId"])
            self.uploads.pop(upload_id, None)
            return {"uploadId": upload_id, "status": "aborted"}
        if op in ("upload_chunk", "upload_commit"):
            fields(request, common + ("uploadId",) + (("offset", "data") if op == "upload_chunk" else ()))
            upload_id = identifier(request["uploadId"])
            upload = self.uploads.get(upload_id)
            if upload is None:
                fail("NOT_FOUND", "Upload is missing or expired")
            upload["updated"] = time.monotonic()
            if op == "upload_chunk":
                offset = integer(request["offset"], 0, MAX_UPLOAD)
                data = decode_data(request["data"], MAX_CHUNK)
                if not data:
                    fail("INVALID_ARGUMENT", "Upload chunk must not be empty")
                current = upload["data"]
                if offset + len(data) > upload["length"]:
                    fail("LIMIT_EXCEEDED", "Chunk exceeds declared upload length")
                if offset < len(current):
                    if offset + len(data) > len(current) or current[offset:offset + len(data)] != data:
                        fail("CONFLICT", "Upload chunk conflicts with previous data")
                elif offset == len(current):
                    current.extend(data)
                else:
                    fail("CONFLICT", "Upload chunks must be sequential")
                return {"uploadId": upload_id, "offset": len(current)}
            # A commit consumes its upload even on invalid data or a busy job slot.
            # Exact request-ID retries replay the cached response without re-execution.
            del self.uploads[upload_id]
            if len(upload["data"]) != upload["length"]:
                fail("INCOMPLETE_UPLOAD", "Upload is incomplete")
            if hashlib.sha256(upload["data"]).hexdigest() != upload["sha256"]:
                fail("CHECKSUM_MISMATCH", "Upload checksum mismatch")
            payload = validate_payload(strict_json(bytes(upload["data"])))
            if self.root is not None and payload["root"] != self.root:
                fail("UNSAFE_ROOT", "Payload root differs from the session root")
            return self.start_job(payload)
        if op in ("job_status", "result_read", "cancel"):
            fields(request, common + ("jobId",) + (("offset", "length") if op == "result_read" else ()))
            job_id = identifier(request["jobId"])
            if op == "result_read":
                integer(request["offset"], 0, MAX_RESULT)
                integer(request["length"], 1, 512)
            with self.lock:
                job = self.jobs.get(job_id)
                if job is None:
                    fail("NOT_FOUND", "Job is missing or expired")
                if op == "cancel":
                    if job.result is not None:
                        return {"jobId": job_id, "status": "done"}
                    if job.payload["kind"] != "exec":
                        fail("NOT_CANCELLABLE", "File operations cannot be cancelled once started")
                    job.cancel.set()
                    return {"jobId": job_id, "status": "cancelling"}
                if job.result is None:
                    return {"jobId": job_id, "status": "running"}
                if op == "job_status":
                    return {"jobId": job_id, "status": "done", "byteLength": len(job.result),
                            "sha256": hashlib.sha256(job.result).hexdigest()}
                offset = integer(request["offset"], 0, len(job.result))
                length = integer(request["length"], 1, 512)
                chunk = job.result[offset:offset + length]
                return {"offset": offset, "data": base64.b64encode(chunk).decode("ascii"),
                        "eof": offset + len(chunk) == len(job.result)}
        if op == "close":
            fields(request, common)
            self.close()
            return {"status": "closed"}
        fail("INVALID_ARGUMENT", "Unknown protocol operation")

    def start_job(self, payload):
        with self.lock:
            if len(self.jobs) >= MAX_JOBS:
                completed = [(value.finished, key) for key, value in self.jobs.items()
                             if value.finished is not None]
                if not completed:
                    fail("BUSY", "Too many active jobs")
                del self.jobs[min(completed)[1]]
            if payload["kind"] == "exec" and any(
                    item.payload["kind"] == "exec" and item.result is None for item in self.jobs.values()):
                fail("BUSY", "Only one command may run at a time")
            job_id = secrets.token_hex(8)
            job = Job(payload)
            self.jobs[job_id] = job
            job.thread = threading.Thread(target=self.run_job, args=(job,), daemon=True)
            job.thread.start()
            return {"jobId": job_id, "status": "running"}

    def run_job(self, job):
        try:
            if job.payload["kind"] == "exec":
                result = run_exec(job.payload, job)
            else:
                with self.file_lock:
                    result = file_operation(job.payload)
            encoded = compact(result)
            if len(encoded) > MAX_RESULT:
                fail("LIMIT_EXCEEDED", "Result exceeds retention limit")
        except Exception as exc:
            encoded = compact(error_result(exc))
        with self.lock:
            job.result = encoded
            job.finished = time.monotonic()
            job.last_access = job.finished

    def close(self):
        self.closed = True
        with self.lock:
            jobs = list(self.jobs.values())
            for job in jobs:
                job.cancel.set()
        for job in jobs:
            if job.thread:
                job.thread.join(timeout=3)
            if job.process:
                kill_group(job.process, signal.SIGKILL)
        self.uploads.clear()


def main():
    if len(sys.argv) != 3 or not ID_RE.fullmatch(sys.argv[1]):
        return 2
    try:
        worker = Worker(sys.argv[1], root=sys.argv[2])
    except Exception as exc:
        Worker(sys.argv[1]).emit("0000000000000000", error_result(exc))
        return 2
    saved_termios = None
    old_handlers = {}
    try:
        if sys.stdin.isatty():
            saved_termios = termios.tcgetattr(sys.stdin.fileno())
            updated = list(saved_termios)
            updated[3] &= ~(termios.ECHO | termios.ECHONL)
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSANOW, updated)
        def interrupted(_signum, _frame):
            raise KeyboardInterrupt
        for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            old_handlers[signum] = signal.signal(signum, interrupted)
        worker.emit("0000000000000000", {"status": "ready", "protocol": 1, "root": worker.root,
                                            "python": ".".join(map(str, sys.version_info[:3]))})
        while not worker.closed:
            raw = sys.stdin.buffer.readline(MAX_INPUT + 2)
            if not raw:
                break
            request_id = "0000000000000000"
            try:
                # The limit applies to the JSON bytes, excluding terminal line endings.
                if len(raw.rstrip(b"\r\n")) > MAX_INPUT or not raw.endswith(b"\n"):
                    while raw and not raw.endswith(b"\n"):
                        raw = sys.stdin.buffer.readline(MAX_INPUT + 2)
                    fail("LIMIT_EXCEEDED", "Input line exceeds 2048-byte limit")
                request = strict_json(raw.rstrip(b"\r\n"))
                if isinstance(request, dict) and isinstance(request.get("id"), str) and ID_RE.fullmatch(request["id"]):
                    request_id = request["id"]
                response = worker.handle(request)
            except Exception as exc:
                response = error_result(exc)
            worker.emit(request_id, response)
    except (KeyboardInterrupt, BrokenPipeError, EOFError):
        pass
    finally:
        # Repeated termination signals must not interrupt terminal restoration.
        for signum in old_handlers:
            signal.signal(signum, signal.SIG_IGN)
        try:
            worker.close()
        finally:
            if saved_termios is not None:
                try:
                    termios.tcsetattr(sys.stdin.fileno(), termios.TCSANOW, saved_termios)
                except (OSError, termios.error):
                    pass
            for signum, handler in old_handlers.items():
                signal.signal(signum, handler)
    return 0


if __name__ == "__main__":
    sys.exit(main())
