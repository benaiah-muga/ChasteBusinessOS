# ADR 0083: Private message attachment staging bypasses approval payloads

## Status

Accepted

## Context

`messaging.uploadMessageAttachment` accepts base64-encoded file content. The
capability is classified as secret so its input must be redacted from the
append-only audit ledger. The ordinary approval flow serializes capability
input into `approvals.payload` and an approval notification outbox event. A
secret-risk policy that required approval could therefore persist private file
bytes outside the attachment store before the upload ran.

## Decision

- Mark only `messaging.uploadMessageAttachment` as exempt from policy approval
  requests. It remains a `secret` risk capability and retains the
  `messaging.write` permission.
- Treat the upload as private, uploader-only reversible draft staging. A
  pending attachment is not shared with conversation members until the
  separately governed `messaging.sendMessage` action links it to a message.
  The uploader can remove an unlinked pending attachment.
- Continue applying the standard secret-class audit redaction marker to the
  entire parsed input. Do not put raw content or an input-derived approval
  payload in the ledger or notification outbox.
- Keep secret-risk policy approval behavior for all other capabilities,
  including pending attachment deletion. The exemption is represented
  explicitly in the Go capability spec and is not inferred from the risk
  label.

## Consequences

Organizations cannot force approval before a private attachment is staged.
They still govern sending through the normal message capability and can
revoke staging by removing the uploader's `messaging.write` permission. The
exception prevents approval payloads from duplicating file content in the
database and outbox.
