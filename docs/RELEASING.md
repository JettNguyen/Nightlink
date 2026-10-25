# Releasing Nightlink on iOS

Nightlink is built on this Mac and uploaded straight to App Store Connect. Nothing goes through EAS
or Xcode's cloud signing. Uploading is fine at any time; **submitting for App Review waits until
Jett says so in that session.**

## A release

1. Set the version in `ios/App/Nightlink.xcodeproj/project.pbxproj` (`ios/App/App.xcodeproj` is a
   link to it): `MARKETING_VERSION` (1.3, 1.4 and so on) and `CURRENT_PROJECT_VERSION` (back to 1
   for a new version, up by one for another upload of the same version). Commit it.
2. Check `.env`. Every `VITE_` value is baked into the bundle at build time: the Supabase URL and
   anon key, the Stripe price ids and payment links (live ones, not `test_`), and the RevenueCat
   iOS key (starts with `appl_`). The build ships whatever `.env` holds right then. The OpenAI and
   Supabase service role keys have no `VITE_` prefix and stay out of the bundle.
3. `./scripts/release-ios.sh` builds the web bundle, copies it into the iOS project, archives,
   exports, validates and uploads. About five minutes.
4. On App Store Connect: make the version, write What's New, pick the build once Apple has
   processed it (4 to 15 minutes), and submit only with Jett's ok.

## Signing

Set up October 24, 2026, alongside Tempify, which uses the same certificate.

| | |
| --- | --- |
| Certificate | Apple Distribution: Jett Nguyen, id `DP55FA2P5M`, expires October 24, 2027 |
| Its private key | Only in `~/Library/Keychains/tempify-signing.keychain-db` on this Mac |
| That keychain's password | In the login keychain, item `tempify-signing-keychain` (the script reads it) |
| Profile | `NightLink App Store`, id `YB3YNWHWJN`, for `dev.nightlink`, expires October 24, 2027 |
| API key | The shared App Store Connect key at `../asc-api-key.p8` (App Manager) |

The project itself signs automatically, so the archive step uses the development certificate and
the team development profile already on this Mac. The export then signs by hand with the
distribution certificate and profile above, because the API key can't use Apple's cloud-managed
certificates.

**When they expire,** make a new certificate and profile through the API (a certificate signing
request from `openssl`, then `POST /v1/certificates` with type `DISTRIBUTION`, then
`POST /v1/profiles` with type `IOS_APP_STORE`), import the certificate into the same keychain, and
install the profile in `~/Library/Developer/Xcode/UserData/Provisioning Profiles`. Do it once for
both apps; they share the certificate.

## Screenshots

There are two iPhone sets, both taken with the status bar set to 9:41 and full bars:

```sh
xcrun simctl status_bar <device> override --time "9:41" --dataNetwork wifi --wifiMode active \
  --wifiBars 3 --cellularMode active --cellularBars 4 --batteryState discharging --batteryLevel 100
```

- **6.9 inch** (display type `APP_IPHONE_67` in the API), 1320 by 2868, from the iPhone 18 Pro Max
  simulator.
- **iPhone Duo** (`APP_IPHONE_DUO`), 2853 by 2007, from the open Duo simulator with
  `xcrun simctl io <device> screenshot --display=primary-1`. The app runs sideways there.

The iPad set carries over from version to version. The old 6.5 inch set was dropped in 1.3.

Screens are taken signed in as Jett's own account, so its dreams and profile can show as they are.
Anyone else's name, picture and words get blurred on the running app, through the simulator's web
inspector, rather than painted over afterward:

```css
.__blur { filter: blur(6px) !important; clip-path: inset(0 round 8px); }
.__blur-round { filter: blur(5px) !important; clip-path: inset(0 round 50%); }
```

The clip keeps each blur inside its own rounded shape. For 1.3 the classes went on the feed's other
posts (avatar, handle, title, text) and on Activity's names and avatars, and a feed post that names
a public figure was hidden. Every PNG is flattened to RGB before upload. The 1.3 sets are in
`~/Desktop/Nightlink Files/SSs/App store connect/1.3`.

Search leaves out your own dreams, so its results are always someone else's. The review account's
demo dreams (search "city") are safe to show.

## iPhone Duo

The Duo's status bar runs down the side of the screen in both postures, so it reports no top inset
and a right inset of 84 points. Folded, the app gets 466 by 678 points; open, it runs on its side
at 951 by 669. The side insets are taken once, on `.app`; fixed bars and overlay backdrops pad
themselves. Check both postures when a layout changes.

## The database

Changes to `supabase/schema.sql` don't apply themselves. Run the changed part in the Supabase SQL
editor for project `iogvbtqelbhutfqodwlp`. The `supabase` command on this Mac is an Intel build
and won't run.
