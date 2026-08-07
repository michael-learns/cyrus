# Tailscale Funnel Setup

This guide exposes a self-hosted Cyrus instance to public webhook providers
through [Tailscale Funnel](https://tailscale.com/kb/1223/funnel). Funnel is
available on Tailscale's free plan and is a convenient option for development
or experimentation on a machine that already runs Tailscale.

> **Security note:** Funnel makes the configured Cyrus port reachable from the
> public internet. Cyrus still verifies webhook signatures, but you should only
> expose the port used by Cyrus.

## Prerequisites

- Tailscale is installed, connected, and supports Funnel
- MagicDNS and HTTPS are enabled for the tailnet
- Cyrus is listening locally on port `3456`
- Your tailnet policy permits the device to use Funnel

See the official [Funnel requirements and limitations](https://tailscale.com/kb/1223/funnel#requirements-and-limitations)
if Funnel cannot be enabled.

## Start the Funnel

Expose Cyrus on the standard HTTPS port:

```bash
tailscale funnel --bg --https=443 3456
```

Tailscale prints a public URL similar to:

```text
https://your-machine.your-tailnet.ts.net/
```

Confirm the mapping:

```bash
tailscale funnel status
```

The output should include:

```text
https://your-machine.your-tailnet.ts.net (Funnel on)
|-- / proxy http://127.0.0.1:3456
```

Add the URL to `~/.cyrus/.env` without a trailing slash:

```bash
CYRUS_BASE_URL=https://your-machine.your-tailnet.ts.net
CYRUS_SERVER_PORT=3456
```

Use the matching webhook URL for each integration. For example, Slack Event
Subscriptions should use:

```text
https://your-machine.your-tailnet.ts.net/slack-webhook
```

## Slack Events Not Reaching Cyrus

Use this section when all of the following are true:

- Slack shows the Request URL as **Verified**
- `app_mention` is listed under **Subscribe to bot events**
- The Cyrus bot token has the `app_mentions:read` scope
- Cyrus is running, but a new `@Cyrus` mention produces no incoming webhook log

### Do not rely only on a local URL check

On a device inside the tailnet, MagicDNS can resolve the Funnel hostname to the
device's private `100.x` Tailscale address. A local `curl` can therefore succeed
through the private tailnet route while completely bypassing the public Funnel
relay that Slack must use.

Compare public and local DNS:

```bash
CYRUS_HOST=your-machine.your-tailnet.ts.net

dig +short @8.8.8.8 "$CYRUS_HOST" A
dig +short "$CYRUS_HOST" A
```

The public lookup normally returns Funnel relay addresses, while the local
lookup can return a private `100.x` address.

### Test the public Funnel path

Force `curl` to use each public Funnel relay instead of the private MagicDNS
address:

```bash
CYRUS_HOST=your-machine.your-tailnet.ts.net

for FUNNEL_IP in $(dig +short @8.8.8.8 "$CYRUS_HOST" A); do
  echo "Testing $FUNNEL_IP"
  curl --include --max-time 15 \
    --resolve "$CYRUS_HOST:443:$FUNNEL_IP" \
    --request POST \
    "https://$CYRUS_HOST/slack-webhook"
done
```

An HTTP `401` response containing `Missing Slack signature headers` is expected.
It proves the request crossed the public Funnel and reached Cyrus; the test does
not pretend to be a signed Slack request.

Errors such as `SSL_ERROR_SYSCALL`, a TLS handshake failure, or a timeout mean
the public Funnel path is not reaching Cyrus even if local tests succeed.

### Refresh the Funnel mapping

Restarting the Tailscale application might preserve a stale Funnel mapping. You
can safely reapply only the Cyrus mapping without resetting other Serve or
Funnel entries:

```bash
tailscale funnel --bg --https=443 3456
```

Run the public-path test again. After it returns the expected HTTP `401`, send a
fresh `@Cyrus` mention in Slack. Previously missed events might not be retried
immediately.

For experiments on a machine that is sometimes offline, enable **Delayed
Events** in the Slack app's **Event Subscriptions** settings so Slack can retry
missed deliveries over a longer window.

## Stop the Funnel

Disable only the public port used by Cyrus:

```bash
tailscale funnel --https=443 off
```
