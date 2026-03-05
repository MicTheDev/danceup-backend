# Fix "SendGrid: 403 access forbidden" when viewing campaign stats

Sending emails works because your SendGrid API key has **Mail Send** permission. Viewing campaign stats (delivered, opens, clicks) fails with 403 because the same key also needs **Stats Read** permission.

## Fix in SendGrid

1. Log in to [SendGrid](https://app.sendgrid.com/).
2. Go to **Settings** → **API Keys**.
3. Either **edit** your existing key (the one stored in Google Secret Manager as `sendgrid-api-key`) or **create a new** key.
4. Under **Restricted Access**, find **Statistics** (or **Stats**) and enable **Read** (or **Full Access** for Statistics).
5. Save. If you created a new key, copy it and update the secret in Google Cloud:
   - Secret Manager → `sendgrid-api-key` → New version → paste the new key.

After the key has Stats Read permission, campaign stats in the Marketing page will load without the 403 error.
