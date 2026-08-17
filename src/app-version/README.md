# Application version

Calendar-version-style (CalVer) versions are based on current or most recent Git tags.

Costlight derives one calendar version for the browser build and health endpoint.

- A clean build at tag name `vYYYY.M.D` uses version `YYYY.M.D`.
- Leading zeros are not allowed (i.e. 2026.08.07 is not allowed).
- Later commits use the nearest reachable release tag and commit distance, such as `2026.8.14-dev.3`.
- A dirty checkout adds `.dirty` and cannot present itself as a release.
- Before the first release, the `HEAD` commit date supplies the calendar date and the repository's total commit count supplies the development number.
- Source archives without Git metadata must provide a valid `COSTLIGHT_VERSION` environment value.
- Shallow clones without a reachable release tag must fetch tags and history or provide `COSTLIGHT_VERSION`.

Release a clean commit by tagging it with its publication date. No package version or development counter needs manual maintenance.
