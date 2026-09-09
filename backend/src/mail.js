// Licence-key delivery email.
//
// The on-screen panel after checkout is not delivery — it is a convenience.
// Close the tab, lose signal mid-poll, or buy on a phone and install on a
// laptop, and the key is gone with no way to get it back. This is the actual
// delivery path; the panel is the fast path.
//
// Requires a domain onboarded to Cloudflare Email Sending. A pages.dev
// subdomain cannot be used: SPF and DKIM records have to live in DNS you
// control. Until MAIL_FROM is set the Worker records the key as undelivered
// rather than silently pretending it sent.

const ACTIVATE_STEPS = [
  'Open the Ad Interceptor toolbar icon',
  'Find the Pro section',
  'Paste the key and press Activate'
];

/**
 * Plain-text body. Always sent alongside the HTML — some clients show only
 * text, and a text part measurably improves spam scoring.
 */
function textBody({ key, deviceLimit, expiresAt, support }) {
  const until = expiresAt
    ? new Date(expiresAt).toISOString().slice(0, 10)
    : null;
  return [
    'Thank you for buying Ad Interceptor Pro.',
    '',
    'Your licence key:',
    '',
    `    ${key}`,
    '',
    'To activate:',
    ...ACTIVATE_STEPS.map((s, i) => `  ${i + 1}. ${s}`),
    '',
    `The key works on up to ${deviceLimit} devices at once. A device you stop`,
    'using is released automatically after 60 days.',
    until ? `\nYour subscription renews on ${until}.` : '',
    '',
    'Keep this email — it is the only copy of your key we send.',
    '',
    `Questions, or need the key again? Reply here or email ${support}.`,
    '',
    '—',
    'Ad Interceptor',
    'Payments are handled by Paddle, our merchant of record.'
  ].filter((l) => l !== null).join('\n');
}

function htmlBody({ key, deviceLimit, expiresAt, support }) {
  const until = expiresAt ? new Date(expiresAt).toISOString().slice(0, 10) : null;
  // Deliberately plain HTML: inline styles only, no external CSS, no images,
  // no tracking pixel. Image-heavy transactional mail lands in spam more often
  // and a tracking pixel in a receipt is exactly the behaviour this product
  // exists to block.
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#f6f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1c1b22;line-height:1.6;">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2deec;border-radius:12px;padding:28px;">
  <h1 style="margin:0 0 6px;font-size:20px;">Your Ad Interceptor Pro key</h1>
  <p style="margin:0 0 20px;color:#6b6775;font-size:14px;">Thank you for your purchase.</p>

  <div style="background:#f1eef7;border:1px solid #e2deec;border-radius:8px;padding:14px;text-align:center;margin-bottom:22px;">
    <code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:17px;letter-spacing:0.05em;">${key}</code>
  </div>

  <p style="margin:0 0 8px;font-weight:600;font-size:14px;">To activate</p>
  <ol style="margin:0 0 20px;padding-left:20px;font-size:14px;color:#3a3944;">
    ${ACTIVATE_STEPS.map((s) => `<li style="margin-bottom:4px;">${s}</li>`).join('')}
  </ol>

  <p style="margin:0 0 6px;font-size:13.5px;color:#6b6775;">
    Works on up to ${deviceLimit} devices at once. A device you stop using is released automatically after 60 days.
  </p>
  ${until ? `<p style="margin:0 0 6px;font-size:13.5px;color:#6b6775;">Your subscription renews on ${until}.</p>` : ''}
  <p style="margin:16px 0 0;font-size:13.5px;color:#6b6775;">
    Keep this email — it is the only copy of your key we send.
    Need it again? Email <a href="mailto:${support}" style="color:#6d28d9;">${support}</a>.
  </p>

  <hr style="border:none;border-top:1px solid #e2deec;margin:22px 0 14px;">
  <p style="margin:0;font-size:12px;color:#90909c;">
    Ad Interceptor. Payments are handled by Paddle, our merchant of record.
  </p>
</div>
</body></html>`;
}

/**
 * Email a licence key, at most once per key.
 *
 * Returns a short status string for the log. Never throws: a failed send must
 * not fail the webhook, because Paddle would retry the whole event and the
 * licence work has already succeeded.
 */
export async function sendLicenceKey(env, { key, email, deviceLimit, expiresAt }) {
  if (!key || !email) return 'skipped: no key or address';
  if (!env.EMAIL || !env.MAIL_FROM) return 'skipped: sending not configured';

  // Claim the send before doing it. Paddle delivers several events per
  // purchase and retries them, so two invocations can reach this point at
  // once; the conditional UPDATE lets exactly one win. Duplicate "here is your
  // key" emails read as a compromised account.
  const now = Date.now();
  const claim = await env.DB.prepare(
    'UPDATE licenses SET key_sent_at = ? WHERE key = ? AND key_sent_at IS NULL'
  ).bind(now, key).run();

  if (!claim.meta?.changes) return 'skipped: already sent';

  const support = env.SUPPORT_EMAIL || env.MAIL_FROM;
  const fields = { key, deviceLimit: deviceLimit ?? 3, expiresAt, support };

  try {
    await env.EMAIL.send({
      to: email,
      from: { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME || 'Ad Interceptor' },
      subject: 'Your Ad Interceptor Pro licence key',
      text: textBody(fields),
      html: htmlBody(fields)
    });
    return `sent to ${email}`;
  } catch (err) {
    // Release the claim so a retry — or a manual resend — can try again, and
    // record why. A key recorded as delivered but never sent is the worst
    // outcome: the customer has nothing and nothing says so.
    await env.DB.prepare(
      'UPDATE licenses SET key_sent_at = NULL, key_send_error = ? WHERE key = ?'
    ).bind(String(err).slice(0, 300), key).run();
    return `FAILED: ${String(err).slice(0, 120)}`;
  }
}
