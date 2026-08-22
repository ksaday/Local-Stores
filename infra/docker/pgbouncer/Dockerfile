# PgBouncer, built from Debian's package rather than pulled from a community
# image.
#
# Every request for money in this platform passes through this container. The
# popular PgBouncer images are maintained by individuals and organisations with
# no relationship to this project, and a compromised one sits directly between
# the application and every row in the database. Building from the distribution
# package means the supply chain is Debian's, which is the same one the base
# image already commits to.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends pgbouncer ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# The package creates this user. Running as root would let a compromised
# PgBouncer read the certificate store and anything else in the image.
USER postgres

EXPOSE 6432

# Exec form: PgBouncer is PID 1 and receives SIGTERM directly. It closes the
# listener and drains in-flight transactions rather than cutting them, which
# matters when the transaction in flight is taking someone's payment.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
