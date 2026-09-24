# Security scope

Protect `.state`, enrollment files, master keys, attestation keys and backups as
credentials. A backup can include both encrypted secrets and their local master
key. Copy backups only to private storage. Stop hubs and agents before maintenance.

Use trusted TLS certificates off loopback. Packaged keys are public test fixtures,
never deployment credentials. Software attestation is an operator-signed statement,
not hardware attestation or a workload sandbox. Only trusted fixed operations and
trusted source roots are supported. External code is hash-pinned but remains trusted
executable code. The journal is a single-hub integrity chain, not distributed consensus.

Version 0.4.3 addresses the defects recorded in docs/AUDIT_0.4.3.md. It does not
establish production readiness, cross-host failover or power-loss certification.
Report vulnerabilities without including live tokens, keys, journals or backups.
