#!/bin/zsh
# Check the LIVE PayPal REST credentials, then bring the live webhook's event
# list up to date (scripts/paypal-webhook-setup.mjs). Asks for the Client ID
# and Secret instead of taking them as arguments, so neither lands in shell
# history; the secret is never echoed or printed.
#
#   zsh scripts/paypal-live-webhook.sh

cd "${0:A:h}/.." || exit 1

read "PAYPAL_CLIENT_ID?Live Client ID: "
read -s "PAYPAL_CLIENT_SECRET?Live Secret: "; echo
PAYPAL_CLIENT_ID="${PAYPAL_CLIENT_ID//[[:space:]]/}"
PAYPAL_CLIENT_SECRET="${PAYPAL_CLIENT_SECRET//[[:space:]]/}"
echo "Client ID length ${#PAYPAL_CLIENT_ID}, secret length ${#PAYPAL_CLIENT_SECRET}"

check() {
  curl -s -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" -d grant_type=client_credentials \
    "https://$1/v1/oauth2/token" |
    python3 -c "import json,sys; d=json.load(sys.stdin); print('OK' if 'access_token' in d else d.get('error_description', d))"
}
live=$(check api-m.paypal.com)
sandbox=$(check api-m.sandbox.paypal.com)
echo "Live:    $live"
echo "Sandbox: $sandbox"

if [[ "$live" != "OK" ]]; then
  echo
  if [[ "$sandbox" == "OK" ]]; then
    echo "These are SANDBOX credentials. Switch developer.paypal.com to Live and copy again."
  else
    echo "PayPal rejected these. Copy the Secret from the same app as the Client ID (click Show)."
  fi
  exit 1
fi

echo
PAYPAL_ENV=live PAYPAL_CLIENT_ID="$PAYPAL_CLIENT_ID" PAYPAL_CLIENT_SECRET="$PAYPAL_CLIENT_SECRET" \
  node scripts/paypal-webhook-setup.mjs
