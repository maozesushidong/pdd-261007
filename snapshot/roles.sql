--
-- PostgreSQL database cluster dump
--

\restrict RhYjujKCHfgykzcO6Df9G0mKNZQepyGLDRtX8CVd5oiVtqeilLLgwIUOXgTf3Bl

SET default_transaction_read_only = off;

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;

--
-- Roles
--

CREATE ROLE postgres;
ALTER ROLE postgres WITH SUPERUSER INHERIT CREATEROLE CREATEDB LOGIN REPLICATION BYPASSRLS;
CREATE ROLE workorders;
ALTER ROLE workorders WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS PASSWORD 'SCRAM-SHA-256$4096:BO/V9v++L4Gcf8ZH9JNy4g==$F/ns+1WnbfJfAtZhpqzkwS2T+P5w4vZ/+OS8SuI/C/s=:zxbgJ/9WHDSgotM6GNnZTs/bvaaVpH0cwQaFVDUZO88=';

--
-- User Configurations
--






\unrestrict RhYjujKCHfgykzcO6Df9G0mKNZQepyGLDRtX8CVd5oiVtqeilLLgwIUOXgTf3Bl

--
-- PostgreSQL database cluster dump complete
--

