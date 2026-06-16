---
sidebar_position: 1
title: Backends
description: Backends are used to store and query data in Evidence
---

Backends control how Evidence stores your source query outputs and how those outputs are loaded at runtime.

You configure the backend in `evidence.config.yaml` using `buildOptions.storageMode`.

## Available Backends

Evidence currently supports three storage backends:

1. `parquet` (default)
2. `duckdb`
3. `ducklake`

### Parquet (`storageMode: parquet`)

`parquet` is the default backend and works well for most projects.

- Stores each source query as parquet files
- Supports selective source/query rebuilds
- Good general-purpose option for local development and deployment

```yaml
buildOptions:
  storageMode: parquet
```

If omitted, Evidence defaults to `parquet`.

### DuckDB (`storageMode: duckdb`)

`duckdb` writes results into a single DuckDB database file.

- Produces a single database artifact (`evidence.duckdb`)
- Useful when you want a single-file backend artifact
- Supports selective source/query rebuilds

```yaml
buildOptions:
  storageMode: duckdb
```

### DuckLake (`storageMode: ducklake`)

`ducklake` writes results into a DuckLake catalog (`.ducklake`) plus a data directory.

- Produces a catalog file (`evidence.ducklake`) and DuckLake data files
- Supports local write + remote read paths
- Requires full source builds (filtered/incremental builds are not supported)

```yaml
buildOptions:
  storageMode: ducklake
```

#### DuckLake remote URL behavior

For DuckLake, Evidence persists a remote data path used for read access:

- In local/dev contexts, it resolves to a localhost origin
- In build/deploy contexts, it resolves to your deployment origin

You can explicitly control this with environment variables:

- `EVIDENCE_DUCKLAKE_LOCAL_ORIGIN` (local/dev override)
- `EVIDENCE_DUCKLAKE_DEPLOY_ORIGIN` (build/deploy override)

Evidence also respects `EVIDENCE_DATA_URL_PREFIX` as the data URL prefix.

## Quick Reference

```yaml
# evidence.config.yaml
buildOptions:
  storageMode: parquet # parquet | duckdb | ducklake
```