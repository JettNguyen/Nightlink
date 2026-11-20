#!/usr/bin/env bash
# Builds the Nightlink APK for Android on this Mac, signed with Nightlink's own
# release key. The version comes from the Xcode project, so set it there first.
# docs/RELEASING.md has where the APK goes after.
#
# What it needs, installed on November 20, 2026:
#   brew install openjdk@21
#   brew install --cask android-commandlinetools
#   sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
#
# Usage: ./scripts/build-apk.sh [/path/to/Nightlink.apk]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PATH="/opt/homebrew/bin:$PATH"
export JAVA_HOME="${JAVA_HOME_21:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"

# The key sits outside every repo, beside the App Store key. Lose it and no
# later APK can install over the ones people have, so keep a backup of it.
export NIGHTLINK_KEYSTORE="${NIGHTLINK_KEYSTORE:-$ROOT/../nightlink-android.jks}"
if [ ! -f "$NIGHTLINK_KEYSTORE" ]; then
  echo "The release key isn't at $NIGHTLINK_KEYSTORE. Restore it from its backup; making a new one breaks updates."
  exit 1
fi
NIGHTLINK_KEYSTORE_PASSWORD="$(security find-generic-password -s nightlink-android-keystore -w)"
export NIGHTLINK_KEYSTORE_PASSWORD

if [ ! -x "$JAVA_HOME/bin/java" ] || [ ! -d "$ANDROID_HOME/platforms/android-36" ]; then
  echo "Java 21 or the Android SDK is missing. The top of this script lists what to install."
  exit 1
fi

OUT="${1:-${TMPDIR:-/tmp}/Nightlink.apk}"

npm run build
npx cap sync android
(cd android && caffeinate -i ./gradlew --no-daemon assembleRelease)

APK="android/app/build/outputs/apk/release/app-release.apk"
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify "$APK"
cp "$APK" "$OUT"
echo "Built $OUT"
