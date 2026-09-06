# Nightlink Packages Plan

This repo contains reusable UI and service layers. Below is a lightweight playbook for carving them into publishable packages (npm or GitHub Packages).

## Target Packages

1. **@nightlink/reactions**: emoji picker, popover, long-press orchestration.
2. **@nightlink/activity-hooks**: Firestore hooks for recent activity + presence.
3. **@nightlink/theme-tokens**: CSS variables + typography ramps.

## Repo Structure

```
packages/
  reactions/
    src/
    package.json
    README.md
  activity-hooks/
  theme-tokens/
```

Each package keeps its own `tsconfig`, tests, and `README` snippet with usage.

## Versioning & Publishing

- Use [changesets](https://github.com/changesets/changesets) once multiple packages exist.
- Configure `.npmrc` with `//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}` for GitHub Packages.
- Add `publishConfig.registry` when targeting GitHub Packages; omit for npm public.
- Run `npm run build:packages` before `npm publish` to ensure compiled artifacts exist.

## Checklist Per Package

- [ ] MIT license copy in package folder.
- [ ] Usage example in README.
- [ ] Storybook / examples link.
- [ ] Tests or visual regression snapshots.
- [ ] Bundle size check (use `size-limit`).

## Timeline

| Phase | Scope | Owner |
| --- | --- | --- |
| Week 1 | Extract components + write READMEs | Design Eng |
| Week 2 | Add tests + storybook stories | Design Eng |
| Week 3 | Publish alpha, integrate back into Nightlink | Design Eng |

## Post-Publish

- Add badges to the main README.
- Create template issues for feature requests/bugs.
- Announce on release notes + portfolio site.

---

_Update this plan once packages move beyond concept stage._
