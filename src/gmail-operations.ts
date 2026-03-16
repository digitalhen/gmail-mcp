import { gmail_v1 } from "googleapis";

export interface EmailMessage {
  id: string;
  threadId: string;
  messageIdHeader: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  snippet: string;
  body: string;
  isUnread: boolean;
  labels: string[];
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string
): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";

  // Simple body
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Multipart
  if (payload.parts) {
    // Prefer text/plain, fallback to text/html
    const textPart = payload.parts.find((p) => p.mimeType === "text/plain");
    if (textPart?.body?.data) {
      return decodeBase64Url(textPart.body.data);
    }
    const htmlPart = payload.parts.find((p) => p.mimeType === "text/html");
    if (htmlPart?.body?.data) {
      return decodeBase64Url(htmlPart.body.data);
    }
    // Recurse into nested multipart
    for (const part of payload.parts) {
      const body = extractBody(part);
      if (body) return body;
    }
  }

  return "";
}

function parseMessage(msg: gmail_v1.Schema$Message): EmailMessage {
  const headers = msg.payload?.headers;
  return {
    id: msg.id || "",
    threadId: msg.threadId || "",
    messageIdHeader: getHeader(headers, "Message-ID"),
    from: getHeader(headers, "From"),
    to: getHeader(headers, "To"),
    cc: getHeader(headers, "Cc"),
    subject: getHeader(headers, "Subject"),
    date: getHeader(headers, "Date"),
    snippet: msg.snippet || "",
    body: extractBody(msg.payload),
    isUnread: msg.labelIds?.includes("UNREAD") || false,
    labels: msg.labelIds || [],
  };
}

// RFC 2047 encode a header value if it contains non-ASCII characters
function encodeHeaderValue(value: string): string {
  // Check if the string contains non-ASCII characters
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  // Encode as RFC 2047 Base64
  const encoded = Buffer.from(value, "utf-8").toString("base64");
  return `=?UTF-8?B?${encoded}?=`;
}

export async function sendEmail(
  gmail: gmail_v1.Gmail,
  to: string,
  subject: string,
  body: string,
  cc?: string,
  bcc?: string,
  inReplyTo?: string,
  threadId?: string
): Promise<{ id: string; threadId: string; message: string }> {
  const lines: string[] = [];
  lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  lines.push(`Subject: ${encodeHeaderValue(subject)}`);
  lines.push("MIME-Version: 1.0");
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`);
    lines.push(`References: ${inReplyTo}`);
  }
  lines.push("Content-Type: text/plain; charset=utf-8");
  lines.push("");
  lines.push(body);

  const raw = Buffer.from(lines.join("\r\n"), "utf-8").toString("base64url");

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw,
      ...(threadId ? { threadId } : {}),
    },
  });

  return {
    id: res.data.id || "",
    threadId: res.data.threadId || "",
    message: `Email sent successfully to ${to}`,
  };
}

export async function createDraft(
  gmail: gmail_v1.Gmail,
  to: string,
  subject: string,
  body: string,
  cc?: string,
  bcc?: string,
  inReplyTo?: string,
  threadId?: string
): Promise<{ id: string; messageId: string; threadId: string; message: string }> {
  // Use the default send-as address for From header — Gmail web UI requires this
  const sendAsRes = await gmail.users.settings.sendAs.list({ userId: "me" });
  const defaultSendAs = (sendAsRes.data.sendAs || []).find((sa) => sa.isDefault);
  const fromEmail = defaultSendAs?.sendAsEmail || (await gmail.users.getProfile({ userId: "me" })).data.emailAddress || "";

  const lines: string[] = [];
  lines.push(`From: ${fromEmail}`);
  lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  lines.push(`Subject: ${encodeHeaderValue(subject)}`);
  lines.push("MIME-Version: 1.0");
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`);
    lines.push(`References: ${inReplyTo}`);
  }
  // Gmail web compose needs text/html with the body BEFORE a gmail_quote div
  // to distinguish new content from quoted original
  const htmlBody = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
  lines.push("Content-Type: text/html; charset=utf-8");
  lines.push("");
  lines.push(`<div dir="ltr">${htmlBody}</div><div class="gmail_quote"></div>`);

  const raw = Buffer.from(lines.join("\r\n"), "utf-8").toString("base64url");

  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody: {
      message: {
        raw,
        ...(threadId ? { threadId } : {}),
      },
    },
  });

  return {
    id: res.data.id || "",
    messageId: res.data.message?.id || "",
    threadId: res.data.message?.threadId || "",
    message: `Draft created successfully (to: ${to})`,
  };
}

export async function getRecentEmails(
  gmail: gmail_v1.Gmail,
  maxResults: number = 10,
  query?: string,
  unreadOnly: boolean = false
): Promise<EmailMessage[]> {
  let q = query || "";
  if (unreadOnly) {
    q = q ? `${q} is:unread` : "is:unread";
  }

  const listRes = await gmail.users.messages.list({
    userId: "me",
    maxResults,
    ...(q ? { q } : {}),
  });

  if (!listRes.data.messages || listRes.data.messages.length === 0) {
    return [];
  }

  const messages: EmailMessage[] = [];
  for (const msg of listRes.data.messages) {
    const full = await gmail.users.messages.get({
      userId: "me",
      id: msg.id!,
      format: "full",
    });
    messages.push(parseMessage(full.data));
  }

  return messages;
}

export async function getEmail(
  gmail: gmail_v1.Gmail,
  messageId: string
): Promise<EmailMessage> {
  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });
  return parseMessage(res.data);
}

export async function getThread(
  gmail: gmail_v1.Gmail,
  threadId: string
): Promise<EmailMessage[]> {
  const res = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  });

  return (res.data.messages || []).map(parseMessage);
}

export async function replyToEmail(
  gmail: gmail_v1.Gmail,
  messageId: string,
  body: string
): Promise<{ id: string; threadId: string; message: string }> {
  // Get the original message to extract thread info
  const original = await getEmail(gmail, messageId);

  const subject = original.subject.startsWith("Re:")
    ? original.subject
    : `Re: ${original.subject}`;

  // Use the actual RFC 2822 Message-ID header, not a fabricated one
  const inReplyTo = original.messageIdHeader || `<${original.id}@mail.gmail.com>`;

  return sendEmail(
    gmail,
    original.from,
    subject,
    body,
    undefined,
    undefined,
    inReplyTo,
    original.threadId
  );
}

export async function searchEmails(
  gmail: gmail_v1.Gmail,
  query: string,
  maxResults: number = 10
): Promise<EmailMessage[]> {
  return getRecentEmails(gmail, maxResults, query);
}

export async function modifyLabels(
  gmail: gmail_v1.Gmail,
  messageId: string,
  addLabels: string[] = [],
  removeLabels: string[] = []
): Promise<{ message: string }> {
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: {
      addLabelIds: addLabels,
      removeLabelIds: removeLabels,
    },
  });
  return { message: `Labels modified on message ${messageId}` };
}

export async function markAsRead(
  gmail: gmail_v1.Gmail,
  messageId: string
): Promise<{ message: string }> {
  return modifyLabels(gmail, messageId, [], ["UNREAD"]);
}

export async function markAsUnread(
  gmail: gmail_v1.Gmail,
  messageId: string
): Promise<{ message: string }> {
  return modifyLabels(gmail, messageId, ["UNREAD"], []);
}

export async function trashEmail(
  gmail: gmail_v1.Gmail,
  messageId: string
): Promise<{ message: string }> {
  await gmail.users.messages.trash({
    userId: "me",
    id: messageId,
  });
  return { message: `Message ${messageId} moved to trash` };
}

export async function getLabels(
  gmail: gmail_v1.Gmail
): Promise<{ id: string; name: string; type: string }[]> {
  const res = await gmail.users.labels.list({ userId: "me" });
  return (res.data.labels || []).map((l) => ({
    id: l.id || "",
    name: l.name || "",
    type: l.type || "",
  }));
}
