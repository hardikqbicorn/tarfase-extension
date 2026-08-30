# Certificates

Drop your database provider's CA certificate here when its chain is not in the
system trust store — Supabase signs database certificates with its own CA, so
verification fails without it.

**Supabase:** dashboard → Project Settings → Database → SSL configuration →
Download certificate. Save it here, then in `.env`:

```bash
# Host commands (npm run migrate, npm run check:db)
DATABASE_CA_CERT_FILE=./certs/supabase-ca.crt
```

For the Dockerised services, this directory is mounted at `/app/certs`, so use
the container path instead:

```bash
DATABASE_CA_CERT_FILE=/app/certs/supabase-ca.crt
```

`*.crt` in this directory is gitignored — certificates are not secret, but
there is no reason to commit them.
