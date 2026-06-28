# @stateless/redaction

A **deterministic published-surface hygiene gate** — a classifier that answers
*"does this artifact contain a forbidden identifier?"* with rule-based recognizers.
No model in the hot path: fast, auditable, and a hard halt suitable for guarding a
public push.

It is the enforced version of the published-surface-hygiene check that
[swamp-club Lab 508](https://swamp-club.com/lab/508) shipped only as advisory (a
review dimension + an IPv4-literal warning). The generic patterns are a faithful
port of `llm-catalog-data/scripts/assemble.ts §5d`, generalised to any text/file
set and any consumer.

## Ruleset

- **Generic recognizers** (always on, no fleet knowledge → safe in a community
  checkout): private-range/CGNAT IPv4 *full-quad only* (`10/8`, `192.168/16`,
  `172.16–31/12`, `100.64–127/10`), and `*.ts.net` tailnet hosts. RFC 5737 doc IPs
  (`192.0.2.x` / `198.51.100.x` / `203.0.113.x`) and `example.com` pass clean.
- **Denylist** (the private, fleet-aware part): owned hostnames / FQDNs / people,
  matched **case-sensitively on word boundaries** so an acronym never trips a
  similarly-spelled name. Keep it in a PRIVATE instance; an instance typically
  derives it via a CEL view over `@stateless/inventory` so it grows with the fleet.
- **Custom recognizers**: per-instance `{ name, pattern, flags, placeholder }` for
  e.g. internal TLDs, cloud account-id formats.

## Methods

### `scan` — the hard gate

```bash
# advisory report
swamp model method run my-gate scan --input 'paths:json=["dist","README.md"]' --input failOnHit=false
# hard gate (default): throws on any hit → fails the step / blocks the push
swamp model method run my-gate scan --input 'paths:json=["dist"]'
```

Scans files/dirs (recursively; skips `.git`/`node_modules`/`.swamp`, binaries, and
files > 5 MB) and/or inline `text`. Writes a `scan-result` (`{ clean, hitCount,
hits[], scanned }`); on a hit it logs and, by default, throws
`redaction gate HALT — …`. As a workflow step or a PreToolUse/pre-push hook, that
throw is the halt.

### `redact`

Remaps every recognized identifier to its placeholder (RFC 5737 / `example.com` /
a denylist token) and writes a `redaction-result`.

## Instance shape

```yaml
name: my-gate
denylist: ${{ ... CEL view over @stateless/inventory owned identifiers ... }}
recognizers:
  - name: internal-tld
    pattern: '\b[\w-]+\.(?:internal|corp)\b'
    placeholder: host.example.com
```

## Surfaces

One primitive, many call sites: a swamp **workflow** step, an **ad-hoc** model
method, a **git `pre-push`** hook, a **Claude Code PreToolUse** hook (exit 2 /
`permissionDecision: deny`), and **CI** (generic tier only — community checkouts
have no denylist).

Tier-2 NER/heuristics (flag *suspected new* identifiers → review → learn) and the
self-correcting `learn()` loop are designed but not in this version; see the design
note `docs/decisions/2026-06-28-d7a3f9` in the consuming repo.
