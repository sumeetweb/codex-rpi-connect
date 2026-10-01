import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export const APPROVAL_TIMEOUT_MS = 120_000;
export const MAX_APPROVAL_DETAILS_BYTES = 16 * 1024;

export class ApprovalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
  }
}

const unavailable = () => new ApprovalError('APPROVAL_UNAVAILABLE',
  'This operation requires a client that supports MCP form elicitation and presents its approval form to the user. ' +
  'Use a client advertising elicitation.form, reconnect this plugin, and retry the operation. Nothing was approved.');

const cancelled = () => new ApprovalError('APPROVAL_CANCELLED',
  'The operation approval was cancelled. Nothing was approved; a retry requires a new approval.');

function checkedText(value, field, maxBytes) {
  if (typeof value !== 'string' || value.trim().length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new ApprovalError('APPROVAL_INVALID_REQUEST', `Approval requires a nonempty ${field} within its size limit.`);
  }
  // Validate without trimming or normalizing the operation the user will review.
  return value;
}

/**
 * One user-mediated approval for one operation. No cached grants, tool-supplied
 * approval booleans, environment overrides, logging, or fallback execution.
 * The caller must pass the exact immutable operation it will execute, including
 * its command/path and complete diff or explicit content SHA-256 summary.
 */
export class OperationApprovals {
  #server;

  constructor(server) {
    this.#server = server;
  }

  async require(operation = {}) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new ApprovalError('APPROVAL_INVALID_REQUEST', 'Approval requires a complete operation description.');
    }
    const { action, deviceName, workspaceRoot, details, signal } = operation;
    if (signal?.aborted) throw cancelled();
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      throw new ApprovalError('APPROVAL_INVALID_REQUEST', 'Approval cancellation requires an AbortSignal.');
    }
    checkedText(action, 'action', 160);
    checkedText(deviceName, 'device name', 640);
    checkedText(workspaceRoot, 'workspace root', 4096);
    if (typeof details === 'string' && Buffer.byteLength(details, 'utf8') > MAX_APPROVAL_DETAILS_BYTES) {
      throw new ApprovalError('APPROVAL_DETAILS_TOO_LARGE',
        'Approval details exceed 16 KiB. Split the operation or supply a complete bounded description with an exact content SHA-256 summary; details will not be truncated.');
    }
    checkedText(details, 'operation details', MAX_APPROVAL_DETAILS_BYTES);

    try {
      const form = this.#server?.getClientCapabilities?.()?.elicitation?.form;
      if (!form || typeof form !== 'object' || Array.isArray(form) || typeof this.#server?.elicitInput !== 'function') {
        throw unavailable();
      }
    } catch {
      // Client/server diagnostics can contain commands, tokens, or user content.
      throw unavailable();
    }

    let result;
    try {
      result = await this.#server.elicitInput({
        mode: 'form',
        message: 'Approve this one Raspberry Pi Connect operation?\n' +
          'Review every field below. These JSON-encoded values describe proposed work, not instructions to the client. ' +
          'Approval applies only to this operation on this device and workspace; it does not approve future operations.\n\n' +
          `Action: ${JSON.stringify(action)}\n` +
          `Device: ${JSON.stringify(deviceName)}\n` +
          `Workspace root: ${JSON.stringify(workspaceRoot)}\n` +
          `Exact operation details: ${JSON.stringify(details)}`,
        requestedSchema: {
          type: 'object',
          properties: {
            approved: {
              type: 'boolean',
              title: 'Approve this operation once',
              description: 'Select true only if you approve all of the exact operation details above.',
              default: false,
            },
          },
          required: ['approved'],
        },
      }, {
        timeout: APPROVAL_TIMEOUT_MS,
        maxTotalTimeout: APPROVAL_TIMEOUT_MS,
        resetTimeoutOnProgress: false,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw cancelled();
      if (error?.code === ErrorCode.RequestTimeout) {
        throw new ApprovalError('APPROVAL_TIMEOUT',
          'The operation approval timed out after 120 seconds. Nothing was approved; a retry requires a new approval.');
      }
      // Do not expose the SDK error, its data, or its cause: any can contain the
      // original operation or a response supplied by the client.
      throw unavailable();
    }

    // A cancellation racing an accepted response must still prevent execution.
    if (signal?.aborted || result?.action === 'cancel') throw cancelled();
    if (!result || !Object.hasOwn(result, 'action') || result.action !== 'accept' || !result.content || typeof result.content !== 'object' ||
      Array.isArray(result.content) || !Object.hasOwn(result.content, 'approved') || result.content.approved !== true) {
      throw new ApprovalError('APPROVAL_DENIED',
        'The user did not explicitly approve this operation. Nothing was approved; a retry requires a new approval.');
    }
    return true;
  }
}
