---
'@evidence-dev/duckdb': major
'@evidence-dev/universal-sql': minor
'@evidence-dev/core-components': minor
---

Update to latest duckdb packages

The DuckDB packages have been updated to their latest versions. 

duckdb-async has been replaced with duckdb/node-api. This lead to some changes in how queries
are run and how results are processed. The new duckdb/node-api package offers improved performance
and follows the same release schedule as the main DuckDB project. duckdb-async will be discontinued in
about 6 months.

Additional tests have been added to ensure that semicolons inside block comments do not split SQL 
statements incorrectly. 