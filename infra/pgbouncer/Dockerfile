FROM alpine:3.20

RUN apk add --no-cache gettext pgbouncer postgresql-client \
  && adduser -D -u 10001 pgbouncer

COPY pgbouncer.ini.template /etc/pgbouncer/pgbouncer.ini.template
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER pgbouncer
EXPOSE 6432

ENTRYPOINT ["docker-entrypoint.sh"]
