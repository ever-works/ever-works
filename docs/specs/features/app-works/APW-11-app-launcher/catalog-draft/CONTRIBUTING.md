# Contributing to the Ever platforms catalog

This repository is **data**, not code: one JSON file listing the Ever platforms the App Launcher shows, plus
one icon per platform. A change here reaches every Ever Works installation within an hour of merge (the
reader caches a successful read for one hour — APW-11 FR-12).

## Before you open a pull request

1. **Run the checks locally.** `npx --yes ajv-cli@5 validate -s schema/platforms.schema.json -d platforms.json --spec=draft2020 -m ajv-formats`
   and `node tools/validate.mjs`. The same two commands run in CI.
2. **One platform per pull request.** A change to an existing entry and a new entry are separate pull
   requests, so a broken address can be reverted without taking a new platform with it.
3. **Never rename or reuse an `id`.** Ids are the key a person's pins and hides are stored under
   (`platform:<id>`). Renaming one silently drops every pin on that platform. Add a new entry instead, and
   remove the old one only in a later pull request once the platform has really gone.
4. **Never remove an entry that still exists.** A platform that is temporarily unavailable keeps its entry
   and loses only the environment address it cannot serve; the reader hides it for that environment alone
   (FR-10). An entry is removed when the platform is retired, and that is an owner decision recorded in the
   pull request.

## What a reviewer checks

| Rule                                                               | Why                                                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `https` only, no query strings, no userinfo                        | The launcher opens the address verbatim; a credential in a URL is a leak (FR-31, FR-32).   |
| ≤ 24 entries                                                       | The reader drops the 25th (FR-11).                                                         |
| Unique ids, stable across releases                                 | Pins are keyed by id (plan §3.2).                                                          |
| Icons ≤ 16 KB, `.svg` or `.png`, in `icons/`                       | Icons are inlined into the response; the cap keeps the panel payload small (FR-11, FR-46). |
| No `<script`, `on…=`, `javascript:` or `<foreignObject>` in an SVG | An icon is data, never markup (FR-14).                                                     |
| Name ≤ 40 characters, description ≤ 80 characters                  | The tile is 88 px high at three per row; longer text breaks the grid (spec §6.1).          |
| `status` is `available` or `beta`                                  | Anything else is dropped by the reader (FR-11), so CI refuses it first.                    |
| The address belongs to this platform's own domain                  | A subdomain of another Ever product's domain is forbidden (README D10, R-16).              |

## Addresses per environment

`production`, `stage` and `develop` are independent. An entry may have one, two or three; Ever Works shows the
one for the environment it is running in and hides the entry everywhere else. Never point `stage` or
`develop` at a production address to "make the tile show up" — that is exactly the cross-environment jump
FR-10 forbids.

## Security

Found a problem with an address or an icon — for example an icon that executes something when opened
directly, or an address that redirects somewhere it should not? Open a pull request that removes the
offending icon or address, and say so in the description. Do not open a public issue with a working payload.
