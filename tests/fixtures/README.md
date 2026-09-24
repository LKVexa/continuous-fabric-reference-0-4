# Test-only TLS fixtures

`test-only-cert.pem` and `test-only-key.pem` exist solely for the HTTPS unit test in `tests/fabric.test.js`.

- Subject CN: `CFP public test fixture only`
- SAN: `127.0.0.1`
- **Never** configure these paths in `.state/hub.json` for a real listener.
- `node bin/cfp.js start` refuses TLS material that resolves under `tests/fixtures/`.
