import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

const client = new SESv2Client({});

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  tag: string; // e.g. 'order-lookup', for SES event tracking
}

/**
 * Sends a transactional email through SES. Sender, reply-to and configuration set come from the function's
 * environment (SES_FROM, SES_REPLY_TO, SES_CONFIG_SET), which each stack fills from SSM /greenlove/{env}/ses/*.
 * Returns the SES message id.
 */
export async function sendEmail(msg: EmailMessage): Promise<string | undefined> {
  const from = process.env.SES_FROM;
  if (!from) throw new Error('SES_FROM is not set');
  const res = await client.send(
    new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [msg.to] },
      ReplyToAddresses: process.env.SES_REPLY_TO ? [process.env.SES_REPLY_TO] : undefined,
      ConfigurationSetName: process.env.SES_CONFIG_SET || undefined,
      EmailTags: [{ Name: 'type', Value: msg.tag }],
      Content: {
        Simple: {
          Subject: { Data: msg.subject, Charset: 'UTF-8' },
          Body: { Html: { Data: msg.html, Charset: 'UTF-8' }, Text: { Data: msg.text, Charset: 'UTF-8' } },
        },
      },
    })
  );
  return res.MessageId;
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The GreenLove email frame: a heading, body HTML (already escaped) and the footer. Inline styles only. */
export function emailLayout(heading: string, bodyHtml: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f1ea;font-family:Georgia,'Times New Roman',serif;color:#2f3a2f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ea;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;padding:32px 28px">
<tr><td style="font-size:14px;letter-spacing:2px;text-transform:uppercase;color:#4a7c3f;padding-bottom:8px">GreenLove Farms</td></tr>
<tr><td style="font-size:24px;line-height:1.3;padding-bottom:16px">${escapeHtml(heading)}</td></tr>
<tr><td style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#3d463d">${bodyHtml}</td></tr>
</table>
<p style="font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#7a7f75;margin:16px 0 0">GreenLove Farms LLC · Houston &amp; Conroe, Texas</p>
</td></tr></table>
</body></html>`;
}

export const emailButton = (href: string, label: string) =>
  `<p style="margin:24px 0"><a href="${escapeHtml(href)}" style="background:#4a7c3f;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:bold;display:inline-block">${escapeHtml(label)}</a></p>`;
