<p align="center">
  <a href="https://nightlink.dev">
    <img src="public/favicon.svg" alt="Nightlink logo" width="88" height="88" />
  </a>
</p>

<h1 align="center">
  <a href="https://nightlink.dev">Nightlink</a>
</h1>

<p align="center">
  A dream journal and social network. Log your dreams, get AI-generated titles and analyses, and have the option to share with friends, family, or the world.
</p>

<p align="center">
  <a href="https://apps.apple.com/us/app/nightlink-social/id6768789704?ppid=51e85a05-3f4b-4016-a6f3-34fd77ba46df">
    <img src="https://tools.applemediaservices.com/api/badges/download-on-the-app-store/black/en-us?size=250x83" alt="Download on the App Store" height="48" />
  </a>
  <a href="https://github.com/JettNguyen/Nightlink/releases/latest/download/Nightlink.apk">
    <img src="docs/android-badge.svg" alt="Download for Android" height="48" />
  </a>
</p>

<p align="center">
  <a href="https://github.com/JettNguyen/NightLink/actions/workflows/ci.yml"><img src="https://github.com/JettNguyen/NightLink/actions/workflows/ci.yml/badge.svg" alt="Node.js CI" /></a>
  <a href="https://github.com/JettNguyen/NightLink/actions/workflows/github-code-scanning/codeql"><img src="https://github.com/JettNguyen/NightLink/actions/workflows/github-code-scanning/codeql/badge.svg" alt="CodeQL" /></a>
</p>

## Features

- Private dream journal with tags and visibility controls
- AI dream analysis (title and summary generation)
- Social feed showing dreams from people you follow
- User search and profile customization
- Comment on dreams
- React to dreams and comments
- Works as a Progressive Web App (PWA)

> See [docs/ux-case-study.md](docs/ux-case-study.md) to see why Nightlink exists.

## Android

The Android app isn't on the Play Store. It comes as a file from this repo's
[latest release](https://github.com/JettNguyen/Nightlink/releases/latest):

1. On your phone, download [Nightlink.apk](https://github.com/JettNguyen/Nightlink/releases/latest/download/Nightlink.apk).
2. Open it when it finishes. If Android asks, let your browser install apps.

A newer APK installs over the old one and keeps you signed in. Pro is bought through Stripe in the
Android app, the same way as on the web. Dream reminders come even when the app is closed, but
alerts about other people show only while it's open.

## Use as a Progressive Web App (PWA)

**iOS:**

- Go to the website on an iPhone
- Press the ```Share``` icon
- Select ```Add to Home Screen```
- Ensure ```Open as Web App``` is toggled "On"
- Add

**Android:**

- Go to the website on an Android device
- Click the three dots to open the browser menu
- Select ```Add to home screen```
- Press ```Install```

## Tech Stack

| Layer | Tech |
| --- | --- |
| Frontend | React 19 + Vite, CSS |
| Auth/Data | Supabase (Auth, Postgres, Storage) |
| AI | OpenAI, through a serverless proxy at `/api/ai` |
| iOS and Android apps | Capacitor |
| Payments | Stripe on the web and Android, RevenueCat on iOS |
| Tooling | ESLint 9, Vite PWA plugin, GitHub Actions |
| Hosting | Vercel (with GH Pages fallback workflow) |

## Run it locally

```bash
npm install
npm run dev       # the app at http://localhost:3000
npm run dev:api   # the /api functions at http://localhost:3001, in a second terminal
npm test          # lint, then the unit tests (the *.test.js files, run by Node's test runner)
npm run test:db   # the files in supabase/rollout on a throwaway Postgres (needs postgresql@16 or newer)
npm run build
```

The app reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from a `.env` file. The API
functions also need `OPENAI_API_KEY`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

## CI/CD Flow

1. **GitHub Actions**: Lint, unit tests and build on Node 20 and 22 for every push.
2. **CodeQL**: Security scanning for JavaScript/TypeScript.
3. **Deploy**: Vercel hooks (GH Pages workflow available for static fallback).

## License

Released under the [MIT License](LICENSE).
