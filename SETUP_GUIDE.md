# Setup Guide — ads-automation-kit

> All setup steps run inside the **Google Antigravity CLI (`agy`)**.  
> Authentication matches [SlavaWagner/ai-ads-pipeline](https://github.com/SlavaWagner/ai-ads-pipeline) and [SlavaWagner/swa-google-ads-mcp](https://github.com/SlavaWagner/swa-google-ads-mcp) byte-for-byte.

---

## Option A — Reuse Existing Credentials (`ai-ads-pipeline` / `swa-google-ads-mcp`)

If you already completed OAuth2 authentication in either `ai-ads-pipeline` or `swa-google-ads-mcp`, simply import your `config.json`:

```bash
agy
ads-automation-kit config-import /path/to/ai-ads-pipeline/config.json
ads-automation-kit install-agy
ads-automation-kit status --live
```

Alternatively, point the environment variable directly to your shared credentials file without copying it:

```bash
export ADS_KIT_CONFIG="/absolute/path/to/config.json"
```

---

## Option B — Fresh Google Ads OAuth2 Setup

### 1. Gather Prerequisites
1. **Google Ads Developer Token**: From your Google Ads Manager Account -> *Tools & Settings -> Setup -> API Center*.
2. **Customer ID (10 digits)** and optional **Manager MCC `loginCustomerId`**.
3. **Google Cloud OAuth2 Desktop/Web Credentials**:
   - Enable **Google Ads API** in Google Cloud Console.
   - Configure **OAuth Consent Screen** (add your Google account as a Test User if Testing mode).
   - Create an **OAuth Client ID** and add Authorized Redirect URI:
     ```
     http://localhost:8085
     ```

### 2. Run Interactive Setup inside Antigravity CLI

```bash
agy
npm install
npm link
ads-automation-kit setup
```

During `setup`, the CLI will:
1. Store your Customer ID, MCC ID, Developer Token, OAuth2 Client ID & Secret, API Version (`v24`), and Gemini API Key (default `"antigravity"` for Antigravity Bridge mode) into `config.json`.
2. Start a temporary local HTTP listener on **`http://localhost:8085`** and open your browser to authorize scope `https://www.googleapis.com/auth/adwords` (`access_type=offline&prompt=consent`).
3. Persist both `refreshToken` and `accessToken` (`tokenExpiry` with a 300-second pre-expiry buffer).
4. Offer to register the **56-tool MCP Server** automatically inside `~/.gemini/config/mcp_config.json`.

### 3. Headless / Server Token Renewal

To refresh an expired `accessToken` non-interactively on a remote host:

```bash
ads-automation-kit refresh-token
```

Or re-run full browser OAuth2 consent:

```bash
ads-automation-kit auth
```

---

## Verification Checklist

```bash
# 1. Inspect local config, registered tools (56), agents (25), and MCP config
ads-automation-kit status --live

# 2. Run automated self-test suite (works offline without live Google Ads tokens)
npm test

# 3. Preview a non-interactive read-only campaign report as JSON
ads-automation-kit run campaign --date-range LAST_7_DAYS --json

# 4. Sync Change History into Episodic Memory
ads-automation-kit run change-history-listener --non-interactive
```

---

## Troubleshooting

- **Guard exits with "PREREQUISITE REQUIRED: GOOGLE ANTIGRAVITY CLI"**: Always start inside `agy` (or register the MCP server via `ads-automation-kit install-agy`, which injects `AGY_SESSION: "1"` automatically). For local CI/debugging, pass `--inside-agy`.
- **`DEVELOPER_TOKEN_NOT_APPROVED`**: Ensure your Developer Token has Basic/Standard Access, or target a Google Ads Test Manager Account during development.
- **`USER_PERMISSION_DENIED` on sub-account**: Ensure `loginCustomerId` is set to the 10-digit **Manager (MCC)** account ID that owns access to the client `customerId`. Use the `account-explorer` agent (`Hierarchy` & `Switch` menu options) to verify IDs and switch cleanly.
- **Port `8085` already in use**: Close any local dev server running on port 8085 before running `ads-automation-kit auth`.
