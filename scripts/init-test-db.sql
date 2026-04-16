SELECT 'CREATE DATABASE openhermit_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'openhermit_test')\gexec
