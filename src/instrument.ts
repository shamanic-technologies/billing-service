// Deploy email templates at startup (idempotent upsert)
async function deployEmailTemplates() {
  const url = process.env.TRANSACTIONAL_EMAIL_SERVICE_URL;
  const apiKey = process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
  if (!url || !apiKey) {
    console.warn("TRANSACTIONAL_EMAIL_SERVICE not configured — skipping template deployment");
    return;
  }

  const templates = [
    {
      name: "credits-depleted",
      subject: "Your credits are depleted",
      htmlBody: `<p>Your credit balance has been exhausted. Recharge your account to continue using the platform.</p>
<p><a href="{{rechargeUrl}}">Recharge now</a></p>`,
      textBody: "Your credit balance has been exhausted. Recharge your account to continue using the platform. Visit: {{rechargeUrl}}",
    },
    {
      name: "credits-reload-failed",
      subject: "Automatic reload failed",
      htmlBody: `<p>We attempted to automatically reload your account, but the payment failed. Please update your payment method.</p>
<p><a href="{{settingsUrl}}">Update payment method</a></p>`,
      textBody: "We attempted to automatically reload your account, but the payment failed. Please update your payment method. Visit: {{settingsUrl}}",
    },
  ];

  try {
    const res = await fetch(`${url}/templates`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "x-org-id": "00000000-0000-0000-0000-000000000000",
        "x-user-id": "00000000-0000-0000-0000-000000000000",
        "x-run-id": "00000000-0000-0000-0000-000000000000",
      },
      body: JSON.stringify({ templates }),
    });

    if (!res.ok) {
      console.error(`Failed to deploy email templates: ${res.status} ${await res.text()}`);
      return;
    }

    console.log("Email templates deployed successfully");
  } catch (err) {
    console.error("Failed to deploy email templates:", err);
  }
}

deployEmailTemplates();
