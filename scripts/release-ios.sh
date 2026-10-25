#!/usr/bin/env bash
# Builds Nightlink for the App Store on this Mac and uploads it to App Store Connect.
# Set the version first (MARKETING_VERSION and CURRENT_PROJECT_VERSION in
# ios/App/Nightlink.xcodeproj/project.pbxproj). Uploading never submits for review.
# docs/RELEASING.md has the rest.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# The App Store Connect key is shared with the other apps and sits outside every
# repo. Its id and issuer are read from Studioflow's eas.json so there is one copy.
KEY_PATH="${ASC_KEY_PATH:-$ROOT/../asc-api-key.p8}"
EAS_JSON="$ROOT/../Studioflow/apps/mobile/eas.json"
KEY_ID="${ASC_KEY_ID:-$(node -p "require('$EAS_JSON').submit.production.ios.ascApiKeyId")}"
ISSUER_ID="${ASC_ISSUER_ID:-$(node -p "require('$EAS_JSON').submit.production.ios.ascApiKeyIssuerId")}"

OUT="${TMPDIR:-/tmp}/nightlink-release"
rm -rf "$OUT"
mkdir -p "$OUT"

npm run build
npx cap copy ios

# The distribution key lives in a keychain of its own (shared with Tempify), so
# codesign never stops to ask. Its password is kept in the login keychain.
security unlock-keychain -p "$(security find-generic-password -s tempify-signing-keychain -w)" \
  "$HOME/Library/Keychains/tempify-signing.keychain-db"

# App.xcodeproj is a link to Nightlink.xcodeproj; the target and scheme are both App.
xcodebuild archive \
  -project ios/App/App.xcodeproj \
  -scheme App \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$OUT/Nightlink.xcarchive"

cat > "$OUT/exportOptions.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>destination</key>
  <string>export</string>
  <key>signingStyle</key>
  <string>manual</string>
  <key>teamID</key>
  <string>5SLXY6F2CD</string>
  <key>signingCertificate</key>
  <string>Apple Distribution</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>dev.nightlink</key>
    <string>NightLink App Store</string>
  </dict>
  <key>uploadSymbols</key>
  <true/>
  <key>manageAppVersionAndBuildNumber</key>
  <false/>
</dict>
</plist>
PLIST

xcodebuild -exportArchive \
  -archivePath "$OUT/Nightlink.xcarchive" \
  -exportPath "$OUT" \
  -exportOptionsPlist "$OUT/exportOptions.plist"

# The product is named after the target, so the export is App.ipa.
IPA="$OUT/App.ipa"
unzip -p "$IPA" 'Payload/App.app/Info.plist' > "$OUT/Info.plist"
echo "Built $(plutil -extract CFBundleShortVersionString raw "$OUT/Info.plist") ($(plutil -extract CFBundleVersion raw "$OUT/Info.plist"))"

# altool looks for AuthKey_<id>.p8 in ./private_keys, relative to where it runs.
mkdir -p "$OUT/private_keys"
cp "$KEY_PATH" "$OUT/private_keys/AuthKey_$KEY_ID.p8"
chmod 600 "$OUT/private_keys/AuthKey_$KEY_ID.p8"
trap 'rm -rf "$OUT/private_keys"' EXIT

(cd "$OUT" && xcrun altool --validate-app -f App.ipa -t ios --apiKey "$KEY_ID" --apiIssuer "$ISSUER_ID")
(cd "$OUT" && xcrun altool --upload-app -f App.ipa -t ios --apiKey "$KEY_ID" --apiIssuer "$ISSUER_ID")

echo "Uploaded. Apple takes about 4 to 15 minutes to process it."
