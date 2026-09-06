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
- PWA compatability

> See [docs/ux-case-study.md](docs/ux-case-study.md) to see why Nightlink exists.

## Use as a Progressive Web App (PWA)

**iOS:**

- Go to the website on an iPhone
- Press the ```Share``` icon
- Select ```Add to Home Screen```
- Ensure ```Open as Web App``` is toggled "On"
- Add

**Android:**

- Go to the website on an Andoid device
- Click the three dots to open the browser menu
- Select ```Add to home screen```
- Press ```Install```

## Tech Stack

| Layer | Tech |
| --- | --- |
| Frontend | React 18 + Vite, CSS |
| Auth/Data | Firebase Auth + Firestore |
| AI | API proxy at `/api/ai` |
| Tooling | ESLint 9, Vite PWA plugin, GitHub Actions |
| Hosting | Vercel (with GH Pages fallback workflow) |

## CI/CD Flow

1. **GitHub Actions**: Lint + multi-node builds (18/20/22) per push.
2. **CodeQL**: Security scanning for JavaScript/TypeScript.
3. **Deploy**: Vercel hooks (GH Pages workflow available for static fallback).

## License

Released under the [MIT License](LICENSE).
