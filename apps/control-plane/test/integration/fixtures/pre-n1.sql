--
-- PostgreSQL database dump
--

\restrict 50bibgOZezJQeNoAQCmn3t2uWpKlpKeDbYnsckDHs7edei5sCba0UZ0Q3A6mfB1

-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: drizzle; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA drizzle;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: __drizzle_migrations; Type: TABLE; Schema: drizzle; Owner: -
--

CREATE TABLE drizzle.__drizzle_migrations (
    id integer NOT NULL,
    hash text NOT NULL,
    created_at bigint
);


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE; Schema: drizzle; Owner: -
--

CREATE SEQUENCE drizzle.__drizzle_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: drizzle; Owner: -
--

ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNED BY drizzle.__drizzle_migrations.id;


--
-- Name: api_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    role text NOT NULL,
    token_hash text NOT NULL,
    token_hint text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone
);


--
-- Name: audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    actor jsonb NOT NULL,
    action text NOT NULL,
    environment_id uuid,
    entity_type text NOT NULL,
    entity_id text,
    before jsonb,
    after jsonb,
    ip text
);


--
-- Name: basicauth_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.basicauth_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    environment_id uuid NOT NULL,
    consumer_id uuid NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: certificate_snis; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.certificate_snis (
    environment_id uuid NOT NULL,
    certificate_id uuid NOT NULL,
    name text NOT NULL
);


--
-- Name: certificates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.certificates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    environment_id uuid NOT NULL,
    cert text NOT NULL,
    key text NOT NULL,
    subject text NOT NULL,
    issuer text NOT NULL,
    not_before timestamp with time zone NOT NULL,
    not_after timestamp with time zone NOT NULL,
    fingerprint_sha256 text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cluster_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cluster_nodes (
    cluster_id uuid NOT NULL,
    node_id text NOT NULL,
    token_hash text NOT NULL,
    hostname text NOT NULL,
    kong_version text NOT NULL,
    agent_version text NOT NULL,
    labels jsonb DEFAULT '{}'::jsonb NOT NULL,
    state text DEFAULT 'idle'::text NOT NULL,
    applied_version integer,
    applied_hash text,
    failed_version integer,
    error text,
    kong_healthy boolean DEFAULT false NOT NULL,
    reported_at timestamp with time zone,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: clusters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clusters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    environment_id uuid NOT NULL,
    name text NOT NULL,
    registration_token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: consumers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consumers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    environment_id uuid NOT NULL,
    username text,
    custom_id text,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    acl_groups text[] DEFAULT '{}'::text[] NOT NULL
);


--
-- Name: environment_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.environment_roles (
    user_id uuid NOT NULL,
    environment_id uuid NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT environment_roles_role_ck CHECK ((role = ANY (ARRAY['viewer'::text, 'editor'::text, 'admin'::text, 'none'::text])))
);


--
-- Name: environments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.environments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    publish_mode text DEFAULT 'manual'::text NOT NULL,
    current_version integer,
    has_unpublished_changes boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    draft_changed_at timestamp with time zone,
    draft_requires_publish boolean DEFAULT false NOT NULL
);


--
-- Name: jwt_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jwt_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    environment_id uuid NOT NULL,
    consumer_id uuid NOT NULL,
    key text NOT NULL,
    algorithm text NOT NULL,
    secret text,
    rsa_public_key text,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: keyauth_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.keyauth_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    environment_id uuid NOT NULL,
    consumer_id uuid NOT NULL,
    key text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    key_hash text NOT NULL
);


--
-- Name: login_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_attempts (
    key text NOT NULL,
    failures integer DEFAULT 0 NOT NULL,
    window_started_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_until timestamp with time zone
);


--
-- Name: plugins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plugins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    environment_id uuid NOT NULL,
    name text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    service_id uuid,
    route_id uuid,
    consumer_id uuid,
    config jsonb NOT NULL,
    protocols text[],
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: routes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.routes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    environment_id uuid NOT NULL,
    service_id uuid NOT NULL,
    name text NOT NULL,
    protocols text[] DEFAULT '{http,https}'::text[] NOT NULL,
    methods text[],
    hosts text[],
    paths text[],
    headers jsonb,
    strip_path boolean DEFAULT true NOT NULL,
    preserve_host boolean DEFAULT false NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    analytics_retention_days integer
);


--
-- Name: services; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.services (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    environment_id uuid NOT NULL,
    name text NOT NULL,
    protocol text NOT NULL,
    host text NOT NULL,
    port integer NOT NULL,
    path text,
    retries integer,
    connect_timeout_ms integer,
    read_timeout_ms integer,
    write_timeout_ms integer,
    enabled boolean DEFAULT true NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id_hash text NOT NULL,
    user_id uuid NOT NULL,
    csrf_token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.snapshots (
    environment_id uuid NOT NULL,
    version integer NOT NULL,
    hash text NOT NULL,
    config jsonb NOT NULL,
    state jsonb NOT NULL,
    message text,
    created_by jsonb NOT NULL,
    rollback_of integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: targets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.targets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    environment_id uuid NOT NULL,
    upstream_id uuid NOT NULL,
    target text NOT NULL,
    weight integer DEFAULT 100 NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: upstreams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upstreams (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    environment_id uuid NOT NULL,
    name text NOT NULL,
    algorithm text DEFAULT 'round-robin'::text NOT NULL,
    hash_on text DEFAULT 'none'::text NOT NULL,
    hash_fallback text DEFAULT 'none'::text NOT NULL,
    hash_on_header text,
    hash_fallback_header text,
    hash_on_cookie text,
    hash_on_cookie_path text,
    healthchecks jsonb NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    name text NOT NULL,
    role text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: __drizzle_migrations id; Type: DEFAULT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations ALTER COLUMN id SET DEFAULT nextval('drizzle.__drizzle_migrations_id_seq'::regclass);


--
-- Data for Name: __drizzle_migrations; Type: TABLE DATA; Schema: drizzle; Owner: -
--

INSERT INTO drizzle.__drizzle_migrations VALUES (1, '103926311d4556fdbee66d79565c2f99869feaeec92d5aa0ecb55ca2f06f9f3e', 1792034303905);
INSERT INTO drizzle.__drizzle_migrations VALUES (2, '6192edb6c0ee1b7bb62bba19dad6cf132c99ed921855c0305d93f391400beb30', 1792036001522);
INSERT INTO drizzle.__drizzle_migrations VALUES (3, '3b8503967260792df5631b307833d25c2571ab7133c1995965eec835930e2226', 1792068144198);
INSERT INTO drizzle.__drizzle_migrations VALUES (4, 'bed2207c27c1e9ef9a29c2611307a4a759422a45422d8ed8623b4ed096cabcf6', 1792072517066);
INSERT INTO drizzle.__drizzle_migrations VALUES (5, '76cd655998b8fe125cd17743f2cace1c2379acc76aacc5029b6fb8c118ee2177', 1792103734310);
INSERT INTO drizzle.__drizzle_migrations VALUES (6, '2cbeb33be777896fa730f2b54528f1358295e546780021cc2521cef613fdb898', 1792113959089);
INSERT INTO drizzle.__drizzle_migrations VALUES (7, 'fd3447f1e77a4a9d872237e56fb89a114aa669d244fc5abda906dee4389cfcb6', 1792185231835);
INSERT INTO drizzle.__drizzle_migrations VALUES (8, '3b93fa542bd36f57df2449d0400f9aabf3b23b572586d727d0fd85601ab39b66', 1792201244974);
INSERT INTO drizzle.__drizzle_migrations VALUES (9, 'dd965f798e1ed198f2f50c68b8a4c62cec0e14df2192a6649e636b91b122f31c', 1792262040759);
INSERT INTO drizzle.__drizzle_migrations VALUES (10, '59f48245e49708a8610f718291c7493524450df14d97f77ca3b2822c37b4fa56', 1792283485190);
INSERT INTO drizzle.__drizzle_migrations VALUES (11, '28435db62317392a2c3c97167d7f83d372861598aa04ada68ea81044e5f6529f', 1792301691710);
INSERT INTO drizzle.__drizzle_migrations VALUES (12, '5fa846cd84e0c3d3885eee703467a8e5c2c7c1fb91eff1f4c94e23b21a030670', 1792309444102);


--
-- Data for Name: api_tokens; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: audit_events; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.audit_events VALUES ('f67c1e76-687f-4a73-9462-262c62cdbeb5', '2026-10-25 17:34:14.915575+00', '{"id": "bootstrap", "type": "system"}', 'user.create', NULL, 'user', 'cbadcbdf-b591-4d95-b97f-ba3f00ef3724', NULL, '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "role": "admin", "email": "admin@harness.test", "active": true, "createdAt": "2026-10-25T17:34:14.915Z", "updatedAt": "2026-10-25T17:34:14.915Z"}', NULL);
INSERT INTO public.audit_events VALUES ('b49afd70-19c1-4f5b-842f-0326073b3453', '2026-10-25 17:34:15.078303+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'auth.login', NULL, 'user', 'cbadcbdf-b591-4d95-b97f-ba3f00ef3724', NULL, '{"ok": true}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('19b835a7-6b00-48c8-8ac4-3b7d8e87bde7', '2026-10-25 17:34:15.101897+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'environment.create', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'environment', 'cb880720-f6e4-4621-82fb-2776eb8007b1', NULL, '{"id": "cb880720-f6e4-4621-82fb-2776eb8007b1", "name": "TVRO", "createdAt": "2026-10-25T17:34:15.101Z", "updatedAt": "2026-10-25T17:34:15.101Z", "description": null, "publishMode": "manual", "currentVersion": null, "hasUnpublishedChanges": false, "autoPublishPausedReason": null}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('ea320ed8-8b82-4830-a5e1-b989329c8956', '2026-10-25 17:34:15.112219+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'environment.create', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'environment', 'f549c314-49d9-4638-ab71-b2a764918c5e', NULL, '{"id": "f549c314-49d9-4638-ab71-b2a764918c5e", "name": "tvro.", "createdAt": "2026-10-25T17:34:15.112Z", "updatedAt": "2026-10-25T17:34:15.112Z", "description": null, "publishMode": "manual", "currentVersion": null, "hasUnpublishedChanges": false, "autoPublishPausedReason": null}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('e3ef3753-9ea0-446c-a96a-1c280383ae53', '2026-10-25 17:34:15.130392+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'environment.create', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'environment', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', NULL, '{"id": "26483d97-1fc7-4e4f-b947-05fdb7258cf8", "name": "api", "createdAt": "2026-10-25T17:34:15.130Z", "updatedAt": "2026-10-25T17:34:15.130Z", "description": null, "publishMode": "manual", "currentVersion": null, "hasUnpublishedChanges": false, "autoPublishPausedReason": null}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('45372d45-3703-4355-b66d-a38e99bd980c', '2026-10-25 17:34:15.140681+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'environment.create', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'environment', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', NULL, '{"id": "d3fb7048-4cde-4f7d-b781-67a2b1b5711c", "name": "Pagamentos_PIX", "createdAt": "2026-10-25T17:34:15.140Z", "updatedAt": "2026-10-25T17:34:15.140Z", "description": null, "publishMode": "manual", "currentVersion": null, "hasUnpublishedChanges": false, "autoPublishPausedReason": null}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('6f7a3aea-8922-405d-9dc0-da101f59ae37', '2026-10-25 17:34:15.172501+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'upstream.create', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'upstream', 'bf51756a-e145-4081-b085-b7f9f5914c2a', NULL, '{"id": "bf51756a-e145-4081-b085-b7f9f5914c2a", "name": "pool", "tags": [], "hashOn": "header", "algorithm": "consistent-hashing", "createdAt": "2026-10-25T17:34:15.172Z", "updatedAt": "2026-10-25T17:34:15.172Z", "hashFallback": "none", "hashOnHeader": "X-Client", "healthchecks": {"active": null, "passive": null}}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('99bf137b-f51e-4d3d-aad9-10ec430b74af', '2026-10-25 17:34:15.198457+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'target.create', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'target', 'e71180e3-1834-4269-85e5-9d8e83fe7aaf', NULL, '{"id": "e71180e3-1834-4269-85e5-9d8e83fe7aaf", "tags": [], "target": "backend.example.com:8080", "weight": 50, "createdAt": "2026-10-25T17:34:15.198Z", "updatedAt": "2026-10-25T17:34:15.198Z", "upstreamId": "bf51756a-e145-4081-b085-b7f9f5914c2a"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('3ca1c654-924d-4928-9993-88d97de53c2f', '2026-10-25 17:34:15.217846+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'target.create', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'target', '89daa950-9498-4bfa-af79-49c75b407b70', NULL, '{"id": "89daa950-9498-4bfa-af79-49c75b407b70", "tags": [], "target": "backend2.example.com:8080", "weight": 100, "createdAt": "2026-10-25T17:34:15.217Z", "updatedAt": "2026-10-25T17:34:15.217Z", "upstreamId": "bf51756a-e145-4081-b085-b7f9f5914c2a"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('cdb6ea5e-4201-4500-b0d1-9ca22a80f21f', '2026-10-25 17:34:15.233932+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'service.create', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'service', 'f9c5336a-60cc-42bf-92e8-f7070bef02bc', NULL, '{"id": "f9c5336a-60cc-42bf-92e8-f7070bef02bc", "host": "pool", "name": "orders", "path": "/v1", "port": 80, "tags": [], "enabled": true, "retries": 2, "protocol": "http", "createdAt": "2026-10-25T17:34:15.233Z", "updatedAt": "2026-10-25T17:34:15.233Z"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('ea2bcbe5-8301-4526-9d7b-f870dbc8b7af', '2026-10-25 17:34:15.251928+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'service.create', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'service', '89848d21-0348-4c06-af01-29dd75339d3b', NULL, '{"id": "89848d21-0348-4c06-af01-29dd75339d3b", "host": "echo.example.com", "name": "echo", "path": null, "port": 443, "tags": [], "enabled": true, "protocol": "https", "createdAt": "2026-10-25T17:34:15.251Z", "updatedAt": "2026-10-25T17:34:15.251Z"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('c6417d06-813e-4648-82e1-13892192ef43', '2026-10-25 17:34:15.27388+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'route.create', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'route', '67e43a90-cad0-4848-bef8-0a09ad977bd9', NULL, '{"id": "67e43a90-cad0-4848-bef8-0a09ad977bd9", "name": "with-path", "tags": [], "paths": ["/orders"], "methods": ["GET", "POST"], "createdAt": "2026-10-25T17:34:15.273Z", "protocols": ["http", "https"], "serviceId": "f9c5336a-60cc-42bf-92e8-f7070bef02bc", "stripPath": true, "updatedAt": "2026-10-25T17:34:15.273Z", "preserveHost": false, "analyticsRetentionDays": null}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('c42cb42f-8e86-441d-bba6-cba464d83487', '2026-10-25 17:34:15.286355+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'route.create', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'route', 'edee4706-74b9-4fa7-b4bf-94a631384c4c', NULL, '{"id": "edee4706-74b9-4fa7-b4bf-94a631384c4c", "name": "full-path", "tags": [], "paths": ["/keep", "~/regex/[0-9]+$"], "createdAt": "2026-10-25T17:34:15.286Z", "protocols": ["http", "https"], "serviceId": "f9c5336a-60cc-42bf-92e8-f7070bef02bc", "stripPath": false, "updatedAt": "2026-10-25T17:34:15.286Z", "preserveHost": false, "analyticsRetentionDays": 3}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('00d011d5-b0ac-48ea-80a3-a2d5a86e7f5e', '2026-10-25 17:34:15.295803+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'route.create', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'route', 'a8fd56a5-1de8-44dd-a5e2-d2b1b7a68776', NULL, '{"id": "a8fd56a5-1de8-44dd-a5e2-d2b1b7a68776", "name": "host-only", "tags": [], "hosts": ["echo.example.com"], "createdAt": "2026-10-25T17:34:15.295Z", "protocols": ["http", "https"], "serviceId": "89848d21-0348-4c06-af01-29dd75339d3b", "stripPath": true, "updatedAt": "2026-10-25T17:34:15.295Z", "preserveHost": true, "analyticsRetentionDays": null}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('2119642c-eedb-4a76-b707-9ab465a5878e', '2026-10-25 17:34:15.307234+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'consumer.create', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'consumer', '11d3bf16-b7e1-4533-b6fd-a9f39e96416b', NULL, '{"id": "11d3bf16-b7e1-4533-b6fd-a9f39e96416b", "tags": [], "customId": "sky-1", "username": "app-sky", "createdAt": "2026-10-25T17:34:15.307Z", "updatedAt": "2026-10-25T17:34:15.307Z"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('53eba699-1700-465e-b7f8-1671483a803e', '2026-10-25 17:34:15.317682+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'keyauth.create', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'keyauth_credential', 'd6a93483-cedb-4658-acb2-2e4cce4153b2', NULL, '{"id": "d6a93483-cedb-4658-acb2-2e4cce4153b2", "tags": [], "keyHint": "…6789", "createdAt": "2026-10-25T17:34:15.317Z", "consumerId": "11d3bf16-b7e1-4533-b6fd-a9f39e96416b"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('7c5103a2-8eae-4204-831c-fa4ae3cc7c0b', '2026-10-25 17:34:15.331409+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'jwt.create', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'jwt_credential', 'aca2aa08-9d0b-4e0f-b9c9-eaa143425dd2', NULL, '{"id": "aca2aa08-9d0b-4e0f-b9c9-eaa143425dd2", "key": "issuer-0", "tags": [], "algorithm": "HS256", "createdAt": "2026-10-25T17:34:15.331Z", "consumerId": "11d3bf16-b7e1-4533-b6fd-a9f39e96416b"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('a1ab88ea-67c9-4670-9ea4-4bbf00d4e5ca', '2026-10-25 17:34:15.345418+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'basicauth.create', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'basicauth_credential', '6e42588f-95a8-4a79-bd53-964547feef4b', NULL, '{"id": "6e42588f-95a8-4a79-bd53-964547feef4b", "tags": [], "username": "login-0", "createdAt": "2026-10-25T17:34:15.345Z", "consumerId": "11d3bf16-b7e1-4533-b6fd-a9f39e96416b"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('b0547d43-acf6-4cea-8dc5-e6622c511022', '2026-10-25 17:34:15.356324+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'consumer.acl_groups.replace', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'consumer', '11d3bf16-b7e1-4533-b6fd-a9f39e96416b', '{"groups": []}', '{"groups": ["gold", "readers"]}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('de4b22d1-609d-44cd-804e-099d006dae43', '2026-10-25 17:34:15.382448+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'plugin.create', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'plugin', '7bda90ca-e64f-4330-8644-e2e0defef56b', NULL, '{"id": "7bda90ca-e64f-4330-8644-e2e0defef56b", "name": "key-auth", "tags": [], "scope": {"routeId": "67e43a90-cad0-4848-bef8-0a09ad977bd9", "serviceId": null, "consumerId": null}, "config": {"key_names": ["apikey"]}, "enabled": true, "createdAt": "2026-10-25T17:34:15.382Z", "protocols": ["grpc", "grpcs", "http", "https"], "updatedAt": "2026-10-25T17:34:15.382Z"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('a5f66094-1688-4fef-8d34-19af71a9f933', '2026-10-25 17:34:15.408763+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'plugin.create', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'plugin', '03a7bd59-b272-4f28-be88-69179e382ccd', NULL, '{"id": "03a7bd59-b272-4f28-be88-69179e382ccd", "name": "rate-limiting", "tags": [], "scope": {"routeId": null, "serviceId": "f9c5336a-60cc-42bf-92e8-f7070bef02bc", "consumerId": "11d3bf16-b7e1-4533-b6fd-a9f39e96416b"}, "config": {"minute": 10, "policy": "local"}, "enabled": true, "createdAt": "2026-10-25T17:34:15.408Z", "protocols": ["grpc", "grpcs", "http", "https"], "updatedAt": "2026-10-25T17:34:15.408Z"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('36bc2126-ccb3-4384-a36a-82eae8c31ce1', '2026-10-25 17:34:15.435155+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'plugin.create', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'plugin', '4e9d952d-3331-4677-9f5f-4e139428df04', NULL, '{"id": "4e9d952d-3331-4677-9f5f-4e139428df04", "name": "cors", "tags": [], "scope": {"routeId": null, "serviceId": null, "consumerId": null}, "config": {"origins": ["https://example.com"]}, "enabled": true, "createdAt": "2026-10-25T17:34:15.435Z", "protocols": ["grpc", "grpcs", "http", "https"], "updatedAt": "2026-10-25T17:34:15.435Z"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('fa95312d-beed-4d11-82ea-53ceefbac3f4', '2026-10-25 17:34:15.494171+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'certificate.create', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'certificate', '43ed345d-5199-4c88-a761-ba4ddc70b212', NULL, '{"id": "43ed345d-5199-4c88-a761-ba4ddc70b212", "key": "REDACTED", "cert": "-----BEGIN CERTIFICATE-----\nMIIBrjCCAVSgAwIBAgIUeC3iJp21UDIRBhKlMKCxwmSTaZswCgYIKoZIzj0EAwIw\nHTEbMBkGA1UEAwwSc2l0ZS0wLmV4YW1wbGUuY29tMB4XDTI2MTAyNTE3MzQxNVoX\nDTI2MTEyNDE3MzQxNVowHTEbMBkGA1UEAwwSc2l0ZS0wLmV4YW1wbGUuY29tMFkw\nEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqzC9S/n4c4dBfqxf2FWXbj0O7vhOu3Mp\n34KxvazuDpiU7LvamfRhAura3hMQGoB+9VJZE45Xik7rIH9d/hD8+6NyMHAwHQYD\nVR0OBBYEFOhYw4czmedphWiwiPmXkU5jSaa6MB8GA1UdIwQYMBaAFOhYw4czmedp\nhWiwiPmXkU5jSaa6MA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0RBBYwFIISc2l0ZS0w\nLmV4YW1wbGUuY29tMAoGCCqGSM49BAMCA0gAMEUCIANFerKPnC9BgscdD9pcVMGI\njlKGbj+XAe2NngObmfkWAiEAlNoioigIue26aypUJCCmqYiHZkOEvtL0G/eQWNnt\npVo=\n-----END CERTIFICATE-----\n", "snis": ["site-0.example.com"], "tags": [], "issuer": "CN=site-0.example.com", "subject": "CN=site-0.example.com", "notAfter": "2026-11-24T17:34:15.000Z", "createdAt": "2026-10-25T17:34:15.494Z", "notBefore": "2026-10-25T17:34:15.000Z", "updatedAt": "2026-10-25T17:34:15.494Z", "fingerprintSha256": "F3:96:FC:6C:88:4A:27:23:72:21:6D:0C:F0:54:60:D7:00:D8:83:07:CE:5B:F8:63:BE:1C:94:B3:00:96:3C:F5"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('71fb68e1-6e67-40b5-a92f-2a77748ace32', '2026-10-25 17:34:15.506693+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'snapshot.publish', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'snapshot', '1', NULL, '{"hash": "sha256:4d45a6e83cbaa1800630cf412fdd4dadd214113e42f96401a48994e1a5a7026e", "message": "first", "version": 1, "rollbackOf": null, "changeCount": 18}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('e4f08f32-ff03-473d-8dd0-b1d3a58cc3b4', '2026-10-25 17:34:15.528852+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'route.create', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'route', '22ccbece-d4f5-48fb-b499-a8b85b35c449', NULL, '{"id": "22ccbece-d4f5-48fb-b499-a8b85b35c449", "name": "later", "tags": [], "paths": ["/later"], "createdAt": "2026-10-25T17:34:15.528Z", "protocols": ["http", "https"], "serviceId": "89848d21-0348-4c06-af01-29dd75339d3b", "stripPath": true, "updatedAt": "2026-10-25T17:34:15.528Z", "preserveHost": false, "analyticsRetentionDays": null}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('80528f34-9a49-460d-9803-b879e16f3935', '2026-10-25 17:34:15.540138+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'snapshot.publish', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'snapshot', '2', NULL, '{"hash": "sha256:d857b57b25c4cc9754ca7e94e45d9707a21c0f11d6210985200f3076e6e7c86c", "message": "second", "version": 2, "rollbackOf": null, "changeCount": 1}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('41ebaa52-9009-4d69-8cfd-03bbf6b17f44', '2026-10-25 17:34:15.562308+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'route.create', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'route', '3d95efc1-e261-47d0-8a32-25747bab0998', NULL, '{"id": "3d95efc1-e261-47d0-8a32-25747bab0998", "name": "draft-only", "tags": [], "paths": ["/draft"], "createdAt": "2026-10-25T17:34:15.562Z", "protocols": ["http", "https"], "serviceId": "89848d21-0348-4c06-af01-29dd75339d3b", "stripPath": true, "updatedAt": "2026-10-25T17:34:15.562Z", "preserveHost": false, "analyticsRetentionDays": null}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('c23dc9a9-fc6f-4d13-a4e3-b63a31d3d595', '2026-10-25 17:34:15.572436+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'upstream.create', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'upstream', '1acade81-f636-4a1f-b2dd-d26ae70aafd9', NULL, '{"id": "1acade81-f636-4a1f-b2dd-d26ae70aafd9", "name": "pool", "tags": [], "hashOn": "header", "algorithm": "consistent-hashing", "createdAt": "2026-10-25T17:34:15.572Z", "updatedAt": "2026-10-25T17:34:15.572Z", "hashFallback": "none", "hashOnHeader": "X-Client", "healthchecks": {"active": null, "passive": null}}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('8fb5ba3a-ec1c-4461-bbd7-b309d675199a', '2026-10-25 17:34:15.578977+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'target.create', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'target', '63fc9770-e933-45d5-943e-18e8efec4162', NULL, '{"id": "63fc9770-e933-45d5-943e-18e8efec4162", "tags": [], "target": "backend.example.com:8080", "weight": 50, "createdAt": "2026-10-25T17:34:15.578Z", "updatedAt": "2026-10-25T17:34:15.578Z", "upstreamId": "1acade81-f636-4a1f-b2dd-d26ae70aafd9"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('50b8e021-be63-4e05-adb5-0301cf8ad79c', '2026-10-25 17:34:15.587937+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'target.create', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'target', 'f8fec68a-6e5c-4710-95c6-32a04682094a', NULL, '{"id": "f8fec68a-6e5c-4710-95c6-32a04682094a", "tags": [], "target": "backend2.example.com:8080", "weight": 100, "createdAt": "2026-10-25T17:34:15.587Z", "updatedAt": "2026-10-25T17:34:15.587Z", "upstreamId": "1acade81-f636-4a1f-b2dd-d26ae70aafd9"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('efec1b73-0eed-4833-96db-382106461db2', '2026-10-25 17:34:15.596808+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'service.create', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'service', '55e7b41b-a3cd-4697-9975-a9736d73fa7a', NULL, '{"id": "55e7b41b-a3cd-4697-9975-a9736d73fa7a", "host": "pool", "name": "orders", "path": "/v1", "port": 80, "tags": [], "enabled": true, "retries": 2, "protocol": "http", "createdAt": "2026-10-25T17:34:15.596Z", "updatedAt": "2026-10-25T17:34:15.596Z"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('d04adb7d-1337-4e73-9e2f-b43cf10de56d', '2026-10-25 17:34:15.611113+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'service.create', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'service', '8bf24b6a-1181-4f5e-8c80-121de795a86a', NULL, '{"id": "8bf24b6a-1181-4f5e-8c80-121de795a86a", "host": "echo.example.com", "name": "echo", "path": null, "port": 443, "tags": [], "enabled": true, "protocol": "https", "createdAt": "2026-10-25T17:34:15.611Z", "updatedAt": "2026-10-25T17:34:15.611Z"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('3ad27d5c-ece8-4990-9ff6-2efda1755c42', '2026-10-25 17:34:15.62859+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'route.create', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'route', '9777d00d-97b0-4631-906e-9f6f32a637c6', NULL, '{"id": "9777d00d-97b0-4631-906e-9f6f32a637c6", "name": "with-path", "tags": [], "paths": ["/orders"], "methods": ["GET", "POST"], "createdAt": "2026-10-25T17:34:15.628Z", "protocols": ["http", "https"], "serviceId": "55e7b41b-a3cd-4697-9975-a9736d73fa7a", "stripPath": true, "updatedAt": "2026-10-25T17:34:15.628Z", "preserveHost": false, "analyticsRetentionDays": null}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('326ea36b-1c88-441b-af2c-e5ce6c74c7f5', '2026-10-25 17:34:15.637888+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'route.create', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'route', 'c5a3b4b1-ccf0-42a5-b61e-90275ceb1687', NULL, '{"id": "c5a3b4b1-ccf0-42a5-b61e-90275ceb1687", "name": "full-path", "tags": [], "paths": ["/keep", "~/regex/[0-9]+$"], "createdAt": "2026-10-25T17:34:15.637Z", "protocols": ["http", "https"], "serviceId": "55e7b41b-a3cd-4697-9975-a9736d73fa7a", "stripPath": false, "updatedAt": "2026-10-25T17:34:15.637Z", "preserveHost": false, "analyticsRetentionDays": 3}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('cd80f466-bcf5-4b7e-a036-f8611844c47a', '2026-10-25 17:34:15.659282+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'route.create', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'route', '0547214f-b67f-4392-a7a5-ee4d0a3fce62', NULL, '{"id": "0547214f-b67f-4392-a7a5-ee4d0a3fce62", "name": "host-only", "tags": [], "hosts": ["echo.example.com"], "createdAt": "2026-10-25T17:34:15.659Z", "protocols": ["http", "https"], "serviceId": "8bf24b6a-1181-4f5e-8c80-121de795a86a", "stripPath": true, "updatedAt": "2026-10-25T17:34:15.659Z", "preserveHost": true, "analyticsRetentionDays": null}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('06af72e8-04fc-40c2-8531-77a1f47a3bd2', '2026-10-25 17:34:15.673326+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'consumer.create', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'consumer', '333c9c1d-8a03-4b1f-a62b-f2f8c07f7427', NULL, '{"id": "333c9c1d-8a03-4b1f-a62b-f2f8c07f7427", "tags": [], "customId": "sky-1", "username": "app-sky", "createdAt": "2026-10-25T17:34:15.673Z", "updatedAt": "2026-10-25T17:34:15.673Z"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('93d1bfb7-48c8-49e7-bad8-2ff5ce3d0a2c', '2026-10-25 17:34:15.684468+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'keyauth.create', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'keyauth_credential', '5e51d754-091e-4d40-b515-c2c01b6d8005', NULL, '{"id": "5e51d754-091e-4d40-b515-c2c01b6d8005", "tags": [], "keyHint": "…6789", "createdAt": "2026-10-25T17:34:15.684Z", "consumerId": "333c9c1d-8a03-4b1f-a62b-f2f8c07f7427"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('bb7478af-e7f4-40a3-aa21-af3fa43263ac', '2026-10-25 17:34:15.711849+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'jwt.create', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'jwt_credential', 'f6b2688c-0b73-437c-8f55-15f74c9658ff', NULL, '{"id": "f6b2688c-0b73-437c-8f55-15f74c9658ff", "key": "issuer-1", "tags": [], "algorithm": "HS256", "createdAt": "2026-10-25T17:34:15.711Z", "consumerId": "333c9c1d-8a03-4b1f-a62b-f2f8c07f7427"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('e63058b5-a5ea-4d0b-9c12-a7b17d700ecc', '2026-10-25 17:34:15.727781+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'basicauth.create', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'basicauth_credential', '7597b013-3f5d-4db1-99db-b7647d3a8b71', NULL, '{"id": "7597b013-3f5d-4db1-99db-b7647d3a8b71", "tags": [], "username": "login-1", "createdAt": "2026-10-25T17:34:15.727Z", "consumerId": "333c9c1d-8a03-4b1f-a62b-f2f8c07f7427"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('a72a4fbd-bcfc-4e71-9755-fcf64c34f1b0', '2026-10-25 17:34:15.739589+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'consumer.acl_groups.replace', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'consumer', '333c9c1d-8a03-4b1f-a62b-f2f8c07f7427', '{"groups": []}', '{"groups": ["gold", "readers"]}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('a0231ef0-fe07-4184-9fcb-1deb0b2c7254', '2026-10-25 17:34:15.759663+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'plugin.create', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'plugin', '5659b8b6-fa90-410a-801d-da934b6079a2', NULL, '{"id": "5659b8b6-fa90-410a-801d-da934b6079a2", "name": "key-auth", "tags": [], "scope": {"routeId": "9777d00d-97b0-4631-906e-9f6f32a637c6", "serviceId": null, "consumerId": null}, "config": {"key_names": ["apikey"]}, "enabled": true, "createdAt": "2026-10-25T17:34:15.759Z", "protocols": ["grpc", "grpcs", "http", "https"], "updatedAt": "2026-10-25T17:34:15.759Z"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('ccd05ef9-9544-475c-88ba-acdc0cb3832e', '2026-10-25 17:34:15.781964+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'plugin.create', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'plugin', '7f329bca-a9d4-42ba-925e-cc2ce2d54d38', NULL, '{"id": "7f329bca-a9d4-42ba-925e-cc2ce2d54d38", "name": "rate-limiting", "tags": [], "scope": {"routeId": null, "serviceId": "55e7b41b-a3cd-4697-9975-a9736d73fa7a", "consumerId": "333c9c1d-8a03-4b1f-a62b-f2f8c07f7427"}, "config": {"minute": 10, "policy": "local"}, "enabled": true, "createdAt": "2026-10-25T17:34:15.781Z", "protocols": ["grpc", "grpcs", "http", "https"], "updatedAt": "2026-10-25T17:34:15.781Z"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('aa92b8b7-87a0-42c1-9ac9-95f9f0bfecd7', '2026-10-25 17:34:15.808957+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'plugin.create', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'plugin', 'c37e25e3-7e45-4f7a-804e-698e62721f9d', NULL, '{"id": "c37e25e3-7e45-4f7a-804e-698e62721f9d", "name": "cors", "tags": [], "scope": {"routeId": null, "serviceId": null, "consumerId": null}, "config": {"origins": ["https://example.com"]}, "enabled": true, "createdAt": "2026-10-25T17:34:15.808Z", "protocols": ["grpc", "grpcs", "http", "https"], "updatedAt": "2026-10-25T17:34:15.808Z"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('5e417ce9-0116-478c-918e-399536d1e3a6', '2026-10-25 17:34:16.011007+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'jwt.create', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'jwt_credential', '8acccf87-334f-4eec-8a30-a69e63e5237e', NULL, '{"id": "8acccf87-334f-4eec-8a30-a69e63e5237e", "key": "issuer-2", "tags": [], "algorithm": "HS256", "createdAt": "2026-10-25T17:34:16.011Z", "consumerId": "bae6f5f3-ba70-4785-a8a3-9f8baac9755a"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('0880269b-3c24-4f0a-9a4e-fa7887d09d35', '2026-10-25 17:34:16.018886+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'basicauth.create', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'basicauth_credential', 'f54d7221-abb8-4daa-879b-c236bedf93f1', NULL, '{"id": "f54d7221-abb8-4daa-879b-c236bedf93f1", "tags": [], "username": "login-2", "createdAt": "2026-10-25T17:34:16.018Z", "consumerId": "bae6f5f3-ba70-4785-a8a3-9f8baac9755a"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('182f8ba9-9cae-4de2-817c-f2d2818fe0cd', '2026-10-25 17:34:16.027594+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'consumer.acl_groups.replace', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'consumer', 'bae6f5f3-ba70-4785-a8a3-9f8baac9755a', '{"groups": []}', '{"groups": ["gold", "readers"]}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('c8ee1f9f-684b-4b08-8d98-e5af6a8d1c06', '2026-10-25 17:34:15.845646+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'certificate.create', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'certificate', '355bcd4b-9fbb-4057-a650-bc575ff0b75f', NULL, '{"id": "355bcd4b-9fbb-4057-a650-bc575ff0b75f", "key": "REDACTED", "cert": "-----BEGIN CERTIFICATE-----\nMIIBrzCCAVSgAwIBAgIUDRsm5Tro/KkUjbTm63jCV2p1vZwwCgYIKoZIzj0EAwIw\nHTEbMBkGA1UEAwwSc2l0ZS0xLmV4YW1wbGUuY29tMB4XDTI2MTAyNTE3MzQxNVoX\nDTI2MTEyNDE3MzQxNVowHTEbMBkGA1UEAwwSc2l0ZS0xLmV4YW1wbGUuY29tMFkw\nEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE/B1acjhvMWHHabWvT98Yx5lypyqz+Mta\nBPzav9+Ber/c8u8OsXSPrfnNbBXHi1SJ2piKvXULl46auYWfdEQzgKNyMHAwHQYD\nVR0OBBYEFJCchBhdjojAfio41h0AolYQFid9MB8GA1UdIwQYMBaAFJCchBhdjojA\nfio41h0AolYQFid9MA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0RBBYwFIISc2l0ZS0x\nLmV4YW1wbGUuY29tMAoGCCqGSM49BAMCA0kAMEYCIQDDfICOykSNXv/hmVZHnakJ\nExXrq7BVXJ1fcwgxQqxSKQIhAITEqFXtmVjF0+2cPcLKyjz49aAGjaV1JoXsOn/1\nGygO\n-----END CERTIFICATE-----\n", "snis": ["site-1.example.com"], "tags": [], "issuer": "CN=site-1.example.com", "subject": "CN=site-1.example.com", "notAfter": "2026-11-24T17:34:15.000Z", "createdAt": "2026-10-25T17:34:15.845Z", "notBefore": "2026-10-25T17:34:15.000Z", "updatedAt": "2026-10-25T17:34:15.845Z", "fingerprintSha256": "C6:36:77:04:E5:17:ED:17:70:25:9A:59:23:B4:09:31:B0:33:F6:AB:44:50:8F:38:9A:7D:C4:CC:37:8B:5B:8E"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('f23716b0-55e8-4ffa-9c99-0dd2897c238c', '2026-10-25 17:34:15.860894+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'snapshot.publish', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'snapshot', '1', NULL, '{"hash": "sha256:2e3ab3ffb8b9d350e8f80908346b58a69159e043fcee6b1b66b4551226c7056c", "message": "first", "version": 1, "rollbackOf": null, "changeCount": 18}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('c4155a65-ddea-455c-8497-e2a8eb45c949', '2026-10-25 17:34:15.885929+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'route.create', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'route', '61a83b09-0187-4ec7-b781-9574cc27a217', NULL, '{"id": "61a83b09-0187-4ec7-b781-9574cc27a217", "name": "later", "tags": [], "paths": ["/later"], "createdAt": "2026-10-25T17:34:15.885Z", "protocols": ["http", "https"], "serviceId": "8bf24b6a-1181-4f5e-8c80-121de795a86a", "stripPath": true, "updatedAt": "2026-10-25T17:34:15.885Z", "preserveHost": false, "analyticsRetentionDays": null}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('03c02cf5-6f47-475a-bb93-db8064c812e7', '2026-10-25 17:34:15.896667+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'snapshot.publish', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'snapshot', '2', NULL, '{"hash": "sha256:3c6a6f1eca3211b250533ab4c1ad4ec9b792a81885a8336d2c136fd1844e0ca6", "message": "second", "version": 2, "rollbackOf": null, "changeCount": 1}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('a9db465b-4352-474f-a2be-13c71639bf35', '2026-10-25 17:34:15.917163+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'upstream.create', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'upstream', '9489cb73-67be-48da-92b9-11cb406bbd3a', NULL, '{"id": "9489cb73-67be-48da-92b9-11cb406bbd3a", "name": "pool", "tags": [], "hashOn": "header", "algorithm": "consistent-hashing", "createdAt": "2026-10-25T17:34:15.917Z", "updatedAt": "2026-10-25T17:34:15.917Z", "hashFallback": "none", "hashOnHeader": "X-Client", "healthchecks": {"active": null, "passive": null}}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('dab02412-f45e-4e11-96ec-3e3a44dbbaa2', '2026-10-25 17:34:15.924866+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'target.create', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'target', 'b7c4cdda-71c4-4aa8-bca3-30084b55ff55', NULL, '{"id": "b7c4cdda-71c4-4aa8-bca3-30084b55ff55", "tags": [], "target": "backend.example.com:8080", "weight": 50, "createdAt": "2026-10-25T17:34:15.924Z", "updatedAt": "2026-10-25T17:34:15.924Z", "upstreamId": "9489cb73-67be-48da-92b9-11cb406bbd3a"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('4c9c4ca7-e7d9-481e-bd27-a67fa8bb9a22', '2026-10-25 17:34:15.933604+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'target.create', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'target', '84512f4d-6fbd-4cce-b390-d769560d5d36', NULL, '{"id": "84512f4d-6fbd-4cce-b390-d769560d5d36", "tags": [], "target": "backend2.example.com:8080", "weight": 100, "createdAt": "2026-10-25T17:34:15.933Z", "updatedAt": "2026-10-25T17:34:15.933Z", "upstreamId": "9489cb73-67be-48da-92b9-11cb406bbd3a"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('86235508-e54b-4d82-a58a-eee42b901fc1', '2026-10-25 17:34:15.942841+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'service.create', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'service', '9c85e098-29e9-4699-9ed5-dac54c2ea9ab', NULL, '{"id": "9c85e098-29e9-4699-9ed5-dac54c2ea9ab", "host": "pool", "name": "orders", "path": "/v1", "port": 80, "tags": [], "enabled": true, "retries": 2, "protocol": "http", "createdAt": "2026-10-25T17:34:15.942Z", "updatedAt": "2026-10-25T17:34:15.942Z"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('37cf3ece-e18b-4848-8c44-49d095f816b3', '2026-10-25 17:34:15.951009+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'service.create', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'service', '129e3112-1d28-41c1-903d-4a863779f778', NULL, '{"id": "129e3112-1d28-41c1-903d-4a863779f778", "host": "echo.example.com", "name": "echo", "path": null, "port": 443, "tags": [], "enabled": true, "protocol": "https", "createdAt": "2026-10-25T17:34:15.951Z", "updatedAt": "2026-10-25T17:34:15.951Z"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('7a2195f1-2bda-4745-a3f9-f236d2fc909b', '2026-10-25 17:34:15.960198+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'route.create', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'route', 'c0ecc470-7d97-4d0b-9012-4520952c2790', NULL, '{"id": "c0ecc470-7d97-4d0b-9012-4520952c2790", "name": "with-path", "tags": [], "paths": ["/orders"], "methods": ["GET", "POST"], "createdAt": "2026-10-25T17:34:15.960Z", "protocols": ["http", "https"], "serviceId": "9c85e098-29e9-4699-9ed5-dac54c2ea9ab", "stripPath": true, "updatedAt": "2026-10-25T17:34:15.960Z", "preserveHost": false, "analyticsRetentionDays": null}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('8692efed-17da-46be-89dd-38f3e62a1edf', '2026-10-25 17:34:15.970458+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'route.create', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'route', '1fa456d4-ea6c-4632-8339-1b326c16a52e', NULL, '{"id": "1fa456d4-ea6c-4632-8339-1b326c16a52e", "name": "full-path", "tags": [], "paths": ["/keep", "~/regex/[0-9]+$"], "createdAt": "2026-10-25T17:34:15.970Z", "protocols": ["http", "https"], "serviceId": "9c85e098-29e9-4699-9ed5-dac54c2ea9ab", "stripPath": false, "updatedAt": "2026-10-25T17:34:15.970Z", "preserveHost": false, "analyticsRetentionDays": 3}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('2607f0df-e7b8-46af-940c-d4699290c6d0', '2026-10-25 17:34:15.979741+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'route.create', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'route', '115e8013-8fce-41df-8b6f-cedeef2d4b7b', NULL, '{"id": "115e8013-8fce-41df-8b6f-cedeef2d4b7b", "name": "host-only", "tags": [], "hosts": ["echo.example.com"], "createdAt": "2026-10-25T17:34:15.979Z", "protocols": ["http", "https"], "serviceId": "129e3112-1d28-41c1-903d-4a863779f778", "stripPath": true, "updatedAt": "2026-10-25T17:34:15.979Z", "preserveHost": true, "analyticsRetentionDays": null}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('be134bf8-2651-46b1-9ff1-abecd1325130', '2026-10-25 17:34:15.989037+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'consumer.create', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'consumer', 'bae6f5f3-ba70-4785-a8a3-9f8baac9755a', NULL, '{"id": "bae6f5f3-ba70-4785-a8a3-9f8baac9755a", "tags": [], "customId": "sky-1", "username": "app-sky", "createdAt": "2026-10-25T17:34:15.989Z", "updatedAt": "2026-10-25T17:34:15.989Z"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('e8831343-9f54-4612-8e46-c484b3ed3567', '2026-10-25 17:34:16.001401+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'keyauth.create', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'keyauth_credential', 'e5eea64e-b264-4f51-9097-c7ba95b3da84', NULL, '{"id": "e5eea64e-b264-4f51-9097-c7ba95b3da84", "tags": [], "keyHint": "…6789", "createdAt": "2026-10-25T17:34:16.001Z", "consumerId": "bae6f5f3-ba70-4785-a8a3-9f8baac9755a"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('3898bc29-f0c0-4335-b788-91911443754b', '2026-10-25 17:34:16.043638+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'plugin.create', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'plugin', 'f1d0edef-dfbd-4afc-9e1b-373cb2b35326', NULL, '{"id": "f1d0edef-dfbd-4afc-9e1b-373cb2b35326", "name": "key-auth", "tags": [], "scope": {"routeId": "c0ecc470-7d97-4d0b-9012-4520952c2790", "serviceId": null, "consumerId": null}, "config": {"key_names": ["apikey"]}, "enabled": true, "createdAt": "2026-10-25T17:34:16.043Z", "protocols": ["grpc", "grpcs", "http", "https"], "updatedAt": "2026-10-25T17:34:16.043Z"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('5d9cd983-7957-4cb8-b8ce-eaa5fc47ae8a', '2026-10-25 17:34:16.061576+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'plugin.create', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'plugin', '8a679557-4c0e-4492-be03-4d10e910a31c', NULL, '{"id": "8a679557-4c0e-4492-be03-4d10e910a31c", "name": "rate-limiting", "tags": [], "scope": {"routeId": null, "serviceId": "9c85e098-29e9-4699-9ed5-dac54c2ea9ab", "consumerId": "bae6f5f3-ba70-4785-a8a3-9f8baac9755a"}, "config": {"minute": 10, "policy": "local"}, "enabled": true, "createdAt": "2026-10-25T17:34:16.061Z", "protocols": ["grpc", "grpcs", "http", "https"], "updatedAt": "2026-10-25T17:34:16.061Z"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('655f7a28-9ae6-4bfb-af31-20ddc5e88c67', '2026-10-25 17:34:16.081011+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'plugin.create', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'plugin', 'eef738a0-54ac-49ae-84b2-2413e579807c', NULL, '{"id": "eef738a0-54ac-49ae-84b2-2413e579807c", "name": "cors", "tags": [], "scope": {"routeId": null, "serviceId": null, "consumerId": null}, "config": {"origins": ["https://example.com"]}, "enabled": true, "createdAt": "2026-10-25T17:34:16.081Z", "protocols": ["grpc", "grpcs", "http", "https"], "updatedAt": "2026-10-25T17:34:16.081Z"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('344bfc7b-5555-425b-843b-e3e3104d7abf', '2026-10-25 17:34:16.107971+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'certificate.create', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'certificate', '6909c4f2-9a67-4033-840b-4b53e9064f9e', NULL, '{"id": "6909c4f2-9a67-4033-840b-4b53e9064f9e", "key": "REDACTED", "cert": "-----BEGIN CERTIFICATE-----\nMIIBrjCCAVSgAwIBAgIUXO1sAH7RYYBYfKtxyWa/5VpCo7QwCgYIKoZIzj0EAwIw\nHTEbMBkGA1UEAwwSc2l0ZS0yLmV4YW1wbGUuY29tMB4XDTI2MTAyNTE3MzQxNloX\nDTI2MTEyNDE3MzQxNlowHTEbMBkGA1UEAwwSc2l0ZS0yLmV4YW1wbGUuY29tMFkw\nEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEf6CDyeAzNMjYDUGAVFbbI7EVQIboOT4v\n6t8gcPjkq9s4nTYwbwaT7ah9KrPotvlGKU39Ut28fqIi3tT0AFhYlaNyMHAwHQYD\nVR0OBBYEFOSa3Siu18O8UkH/jUkQm4bFFCnsMB8GA1UdIwQYMBaAFOSa3Siu18O8\nUkH/jUkQm4bFFCnsMA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0RBBYwFIISc2l0ZS0y\nLmV4YW1wbGUuY29tMAoGCCqGSM49BAMCA0gAMEUCIQCySfsufwKs404WP+Nn9nA3\n18EBq8GHxfpnKEGEtN7MrQIgD9JG4q/v5Q1XUTgE/SPhEDgfHUShrh1KvfXGVoxW\nWXE=\n-----END CERTIFICATE-----\n", "snis": ["site-2.example.com"], "tags": [], "issuer": "CN=site-2.example.com", "subject": "CN=site-2.example.com", "notAfter": "2026-11-24T17:34:16.000Z", "createdAt": "2026-10-25T17:34:16.107Z", "notBefore": "2026-10-25T17:34:16.000Z", "updatedAt": "2026-10-25T17:34:16.107Z", "fingerprintSha256": "B3:A3:BC:68:2A:F0:67:41:86:89:58:BB:EF:55:E9:20:24:CF:FC:C7:6D:1F:0A:9D:B8:61:BF:4A:F5:DF:E0:A9"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('7359e182-6a53-48af-a23a-79f542643bcd', '2026-10-25 17:34:16.117677+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'snapshot.publish', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'snapshot', '1', NULL, '{"hash": "sha256:ac7dff1a71f18f6bec837986db4a945adfb3aa00c33184b2f093d684aafa301e", "message": "first", "version": 1, "rollbackOf": null, "changeCount": 18}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('b34e0375-eb52-4c8e-ac6c-0333d3bdf516', '2026-10-25 17:34:16.134833+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'route.create', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'route', '93387e9c-1623-4180-8fa2-c97be37e0508', NULL, '{"id": "93387e9c-1623-4180-8fa2-c97be37e0508", "name": "later", "tags": [], "paths": ["/later"], "createdAt": "2026-10-25T17:34:16.134Z", "protocols": ["http", "https"], "serviceId": "129e3112-1d28-41c1-903d-4a863779f778", "stripPath": true, "updatedAt": "2026-10-25T17:34:16.134Z", "preserveHost": false, "analyticsRetentionDays": null}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('b5d33341-fa53-4a0a-a478-da7bfcdea69a', '2026-10-25 17:34:16.144176+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'snapshot.publish', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'snapshot', '2', NULL, '{"hash": "sha256:5d0b4f60bbc595be3efbf57e3e35b88538c3b25cc625d69c5b30d9f85b320b34", "message": "second", "version": 2, "rollbackOf": null, "changeCount": 1}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('6239d2ec-75c3-4432-87f7-6ebd8b9efaaf', '2026-10-25 17:34:16.163725+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'route.create', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'route', '7715de2c-b958-4ebf-98e6-9d2cced4db2f', NULL, '{"id": "7715de2c-b958-4ebf-98e6-9d2cced4db2f", "name": "draft-only", "tags": [], "paths": ["/draft"], "createdAt": "2026-10-25T17:34:16.163Z", "protocols": ["http", "https"], "serviceId": "129e3112-1d28-41c1-903d-4a863779f778", "stripPath": true, "updatedAt": "2026-10-25T17:34:16.163Z", "preserveHost": false, "analyticsRetentionDays": null}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('d9a50503-e8ae-43f3-8411-8367d0e58b3b', '2026-10-25 17:34:16.17323+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'upstream.create', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'upstream', 'd30a306d-9e79-4ade-a34d-0efa6bd085f3', NULL, '{"id": "d30a306d-9e79-4ade-a34d-0efa6bd085f3", "name": "pool", "tags": [], "hashOn": "header", "algorithm": "consistent-hashing", "createdAt": "2026-10-25T17:34:16.173Z", "updatedAt": "2026-10-25T17:34:16.173Z", "hashFallback": "none", "hashOnHeader": "X-Client", "healthchecks": {"active": null, "passive": null}}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('3272e98d-3da5-4a4b-8a1c-fd497f00a2b4', '2026-10-25 17:34:16.182248+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'target.create', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'target', '04a2c266-bf1c-44e0-8d1c-ed3b5926ab50', NULL, '{"id": "04a2c266-bf1c-44e0-8d1c-ed3b5926ab50", "tags": [], "target": "backend.example.com:8080", "weight": 50, "createdAt": "2026-10-25T17:34:16.182Z", "updatedAt": "2026-10-25T17:34:16.182Z", "upstreamId": "d30a306d-9e79-4ade-a34d-0efa6bd085f3"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('75220ed1-1b1f-4241-8c4b-5fdbc4fefb22', '2026-10-25 17:34:16.189893+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'target.create', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'target', '4f613f7c-ebd5-4d1f-835e-9fdcc0e2cc05', NULL, '{"id": "4f613f7c-ebd5-4d1f-835e-9fdcc0e2cc05", "tags": [], "target": "backend2.example.com:8080", "weight": 100, "createdAt": "2026-10-25T17:34:16.189Z", "updatedAt": "2026-10-25T17:34:16.189Z", "upstreamId": "d30a306d-9e79-4ade-a34d-0efa6bd085f3"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('2e6c0fea-52a4-4c5e-a48b-b90476889c91', '2026-10-25 17:34:16.20074+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'service.create', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'service', 'd4daa7ea-6696-4a8c-8525-4fc140c910be', NULL, '{"id": "d4daa7ea-6696-4a8c-8525-4fc140c910be", "host": "pool", "name": "orders", "path": "/v1", "port": 80, "tags": [], "enabled": true, "retries": 2, "protocol": "http", "createdAt": "2026-10-25T17:34:16.200Z", "updatedAt": "2026-10-25T17:34:16.200Z"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('caf7474b-89cf-47a4-ae73-215ed4770c97', '2026-10-25 17:34:16.213181+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'service.create', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'service', '7eae504d-7fc1-4d55-a521-8a2f05285c95', NULL, '{"id": "7eae504d-7fc1-4d55-a521-8a2f05285c95", "host": "echo.example.com", "name": "echo", "path": null, "port": 443, "tags": [], "enabled": true, "protocol": "https", "createdAt": "2026-10-25T17:34:16.213Z", "updatedAt": "2026-10-25T17:34:16.213Z"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('46e9883f-13bb-4efa-a5b9-f3bbea6a6803', '2026-10-25 17:34:16.230321+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'route.create', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'route', 'bded781a-77ac-46a2-9551-8ca1607da3d0', NULL, '{"id": "bded781a-77ac-46a2-9551-8ca1607da3d0", "name": "with-path", "tags": [], "paths": ["/orders"], "methods": ["GET", "POST"], "createdAt": "2026-10-25T17:34:16.230Z", "protocols": ["http", "https"], "serviceId": "d4daa7ea-6696-4a8c-8525-4fc140c910be", "stripPath": true, "updatedAt": "2026-10-25T17:34:16.230Z", "preserveHost": false, "analyticsRetentionDays": null}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('d5659d8f-d9c7-4ec0-a0f0-f9561d9ea13f', '2026-10-25 17:34:16.251298+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'route.create', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'route', 'a09e9d02-9631-4ad3-9aef-cdf235a496a9', NULL, '{"id": "a09e9d02-9631-4ad3-9aef-cdf235a496a9", "name": "full-path", "tags": [], "paths": ["/keep", "~/regex/[0-9]+$"], "createdAt": "2026-10-25T17:34:16.251Z", "protocols": ["http", "https"], "serviceId": "d4daa7ea-6696-4a8c-8525-4fc140c910be", "stripPath": false, "updatedAt": "2026-10-25T17:34:16.251Z", "preserveHost": false, "analyticsRetentionDays": 3}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('dc3dc468-6b7b-4329-af70-7feb16fbcc69', '2026-10-25 17:34:16.260115+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'route.create', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'route', 'cbb6be06-1963-4941-919e-a924ce386e7d', NULL, '{"id": "cbb6be06-1963-4941-919e-a924ce386e7d", "name": "host-only", "tags": [], "hosts": ["echo.example.com"], "createdAt": "2026-10-25T17:34:16.260Z", "protocols": ["http", "https"], "serviceId": "7eae504d-7fc1-4d55-a521-8a2f05285c95", "stripPath": true, "updatedAt": "2026-10-25T17:34:16.260Z", "preserveHost": true, "analyticsRetentionDays": null}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('9931e249-e9c7-4270-9b6d-529d6b0466b5', '2026-10-25 17:34:16.269252+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'consumer.create', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'consumer', 'e41005c7-6431-4ea7-814f-6d5a1b8743d9', NULL, '{"id": "e41005c7-6431-4ea7-814f-6d5a1b8743d9", "tags": [], "customId": "sky-1", "username": "app-sky", "createdAt": "2026-10-25T17:34:16.269Z", "updatedAt": "2026-10-25T17:34:16.269Z"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('0079e3c0-a3e7-476e-b62b-942a71f66951', '2026-10-25 17:34:16.277556+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'keyauth.create', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'keyauth_credential', '3aba1cd8-b7ef-4bd2-a916-09fc91a234a3', NULL, '{"id": "3aba1cd8-b7ef-4bd2-a916-09fc91a234a3", "tags": [], "keyHint": "…6789", "createdAt": "2026-10-25T17:34:16.277Z", "consumerId": "e41005c7-6431-4ea7-814f-6d5a1b8743d9"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('b44292f2-2822-4a72-90dc-ea8933d5c7bd', '2026-10-25 17:34:16.285993+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'jwt.create', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'jwt_credential', 'a07c9f1a-3317-4d21-8148-f53083577e2e', NULL, '{"id": "a07c9f1a-3317-4d21-8148-f53083577e2e", "key": "issuer-3", "tags": [], "algorithm": "HS256", "createdAt": "2026-10-25T17:34:16.285Z", "consumerId": "e41005c7-6431-4ea7-814f-6d5a1b8743d9"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('9b4834b4-b8f2-428c-9b6e-0d6de5b92b74', '2026-10-25 17:34:16.294392+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'basicauth.create', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'basicauth_credential', '6de955fd-2b53-40c8-8064-c747d6f26156', NULL, '{"id": "6de955fd-2b53-40c8-8064-c747d6f26156", "tags": [], "username": "login-3", "createdAt": "2026-10-25T17:34:16.294Z", "consumerId": "e41005c7-6431-4ea7-814f-6d5a1b8743d9"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('5e988034-eb32-40f4-b4f3-48167d4bc06f', '2026-10-25 17:34:16.303505+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'consumer.acl_groups.replace', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'consumer', 'e41005c7-6431-4ea7-814f-6d5a1b8743d9', '{"groups": []}', '{"groups": ["gold", "readers"]}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('2c56f114-12e2-4f11-8dd0-e08368462c8e', '2026-10-25 17:34:16.320665+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'plugin.create', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'plugin', 'cfaa5a9c-a841-4a22-a51b-f434af751919', NULL, '{"id": "cfaa5a9c-a841-4a22-a51b-f434af751919", "name": "key-auth", "tags": [], "scope": {"routeId": "bded781a-77ac-46a2-9551-8ca1607da3d0", "serviceId": null, "consumerId": null}, "config": {"key_names": ["apikey"]}, "enabled": true, "createdAt": "2026-10-25T17:34:16.320Z", "protocols": ["grpc", "grpcs", "http", "https"], "updatedAt": "2026-10-25T17:34:16.320Z"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('159125f3-b3e5-424e-92a7-991166d4df21', '2026-10-25 17:34:16.340545+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'plugin.create', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'plugin', 'bdb37912-eb72-4bd8-b24d-837725c3b48d', NULL, '{"id": "bdb37912-eb72-4bd8-b24d-837725c3b48d", "name": "rate-limiting", "tags": [], "scope": {"routeId": null, "serviceId": "d4daa7ea-6696-4a8c-8525-4fc140c910be", "consumerId": "e41005c7-6431-4ea7-814f-6d5a1b8743d9"}, "config": {"minute": 10, "policy": "local"}, "enabled": true, "createdAt": "2026-10-25T17:34:16.340Z", "protocols": ["grpc", "grpcs", "http", "https"], "updatedAt": "2026-10-25T17:34:16.340Z"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('f4c74e74-52ca-4bbf-9c51-f20768e366ad', '2026-10-25 17:34:16.36587+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'plugin.create', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'plugin', '8aafdaba-73b0-4eb8-bd48-61b7fd76c0a5', NULL, '{"id": "8aafdaba-73b0-4eb8-bd48-61b7fd76c0a5", "name": "cors", "tags": [], "scope": {"routeId": null, "serviceId": null, "consumerId": null}, "config": {"origins": ["https://example.com"]}, "enabled": true, "createdAt": "2026-10-25T17:34:16.365Z", "protocols": ["grpc", "grpcs", "http", "https"], "updatedAt": "2026-10-25T17:34:16.365Z"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('ceb3ba16-de01-405f-9aa6-66665180c08e', '2026-10-25 17:34:16.390622+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'certificate.create', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'certificate', 'a37185f9-ec3c-4bd8-9e85-6b8bd7bd99ff', NULL, '{"id": "a37185f9-ec3c-4bd8-9e85-6b8bd7bd99ff", "key": "REDACTED", "cert": "-----BEGIN CERTIFICATE-----\nMIIBrjCCAVSgAwIBAgIUOWOnNJHl9kd7fS1jnuH0kIzOKSUwCgYIKoZIzj0EAwIw\nHTEbMBkGA1UEAwwSc2l0ZS0zLmV4YW1wbGUuY29tMB4XDTI2MTAyNTE3MzQxNloX\nDTI2MTEyNDE3MzQxNlowHTEbMBkGA1UEAwwSc2l0ZS0zLmV4YW1wbGUuY29tMFkw\nEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE15Ngu3LirXmpI1kRYFR2nHA3bN0j0DQA\nWg0s7M5rlLkJJ95pRn33KybaLB24BwQCda8j7qYhplNzE4xNGBKqkaNyMHAwHQYD\nVR0OBBYEFGRQVOKF0yoJey5onz/86lsgh0VpMB8GA1UdIwQYMBaAFGRQVOKF0yoJ\ney5onz/86lsgh0VpMA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0RBBYwFIISc2l0ZS0z\nLmV4YW1wbGUuY29tMAoGCCqGSM49BAMCA0gAMEUCIBtzwuQJMzwZcE1rUImSXVWV\nPuRPlGcTH37ThYlCkFc+AiEAl9rxzAQu43GslEo7O69zE9EIhvgbBq5ULm9RQFGT\nNfo=\n-----END CERTIFICATE-----\n", "snis": ["site-3.example.com"], "tags": [], "issuer": "CN=site-3.example.com", "subject": "CN=site-3.example.com", "notAfter": "2026-11-24T17:34:16.000Z", "createdAt": "2026-10-25T17:34:16.390Z", "notBefore": "2026-10-25T17:34:16.000Z", "updatedAt": "2026-10-25T17:34:16.390Z", "fingerprintSha256": "DC:5E:3F:CA:63:AF:F4:92:F9:3C:77:D6:EF:6F:E7:3B:BA:3A:EE:B2:D3:F1:1F:08:E2:6B:A6:B7:57:9A:C7:CA"}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('f4ca00b9-3090-41f4-8aa2-6e32c2085e46', '2026-10-25 17:34:16.401122+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'snapshot.publish', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'snapshot', '1', NULL, '{"hash": "sha256:894963eefb2fb8938034a84edc07a2b1c8f549d03b74c51e2d2c519da8482f75", "message": "first", "version": 1, "rollbackOf": null, "changeCount": 18}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('1cecb81e-3f5e-449a-9d94-30083d1ed93d', '2026-10-25 17:34:16.419127+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'route.create', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'route', '53933b6e-85e3-4d1f-8b5b-6f65c9822608', NULL, '{"id": "53933b6e-85e3-4d1f-8b5b-6f65c9822608", "name": "later", "tags": [], "paths": ["/later"], "createdAt": "2026-10-25T17:34:16.419Z", "protocols": ["http", "https"], "serviceId": "7eae504d-7fc1-4d55-a521-8a2f05285c95", "stripPath": true, "updatedAt": "2026-10-25T17:34:16.419Z", "preserveHost": false, "analyticsRetentionDays": null}', '127.0.0.1');
INSERT INTO public.audit_events VALUES ('128791e1-2a57-45ef-95ab-9813a19d9eea', '2026-10-25 17:34:16.428261+00', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', 'snapshot.publish', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'snapshot', '2', NULL, '{"hash": "sha256:ffb50d60aa8f5630df4603f9495f00cc4f8e9c1ed047527fec4b264e0c7cd01c", "message": "second", "version": 2, "rollbackOf": null, "changeCount": 1}', '127.0.0.1');


--
-- Data for Name: basicauth_credentials; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.basicauth_credentials VALUES ('6e42588f-95a8-4a79-bd53-964547feef4b', 'cb880720-f6e4-4621-82fb-2776eb8007b1', '11d3bf16-b7e1-4533-b6fd-a9f39e96416b', 'login-0', 'enc:v2:k1:4fbQCMXhAR5R7r1h:wB-FM3rOkBz8FGTYdKuGGrhKbzA4_jfc0C1YrRHsSdiNOwTlVOFYZA:MmzXEaDewEkdVK3Onb8NmQ', '{}', '2026-10-25 17:34:15.345418+00');
INSERT INTO public.basicauth_credentials VALUES ('7597b013-3f5d-4db1-99db-b7647d3a8b71', 'f549c314-49d9-4638-ab71-b2a764918c5e', '333c9c1d-8a03-4b1f-a62b-f2f8c07f7427', 'login-1', 'enc:v2:k1:5Rua-DIuslbmGsDw:__BLEL-3QLUM27_RzEGs4DqwiwsrYxZvCJPV2QyEsQisQOzxYS6y9Q:TeF8CN1Z-ow7R1qeaupjPw', '{}', '2026-10-25 17:34:15.727781+00');
INSERT INTO public.basicauth_credentials VALUES ('f54d7221-abb8-4daa-879b-c236bedf93f1', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'bae6f5f3-ba70-4785-a8a3-9f8baac9755a', 'login-2', 'enc:v2:k1:7lnRJxJnxUhK3AEs:tfgwg1DnkGeZRqCEg4GtzFWB_BCoS_rU7-o2HvqFARZbOgpE6Y1Juw:MQTy6ymR30ybBJISSxTMpg', '{}', '2026-10-25 17:34:16.018886+00');
INSERT INTO public.basicauth_credentials VALUES ('6de955fd-2b53-40c8-8064-c747d6f26156', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'e41005c7-6431-4ea7-814f-6d5a1b8743d9', 'login-3', 'enc:v2:k1:8PpSnMXrUMoR7kgd:ub11n5LtFrargTVlrqr507YLOsD9jy6Yf9aOt-VQP3VQmfjPfKvADg:cL8dgXWDmC3eYmpxjs2ZQw', '{}', '2026-10-25 17:34:16.294392+00');


--
-- Data for Name: certificate_snis; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.certificate_snis VALUES ('cb880720-f6e4-4621-82fb-2776eb8007b1', '43ed345d-5199-4c88-a761-ba4ddc70b212', 'site-0.example.com');
INSERT INTO public.certificate_snis VALUES ('f549c314-49d9-4638-ab71-b2a764918c5e', '355bcd4b-9fbb-4057-a650-bc575ff0b75f', 'site-1.example.com');
INSERT INTO public.certificate_snis VALUES ('26483d97-1fc7-4e4f-b947-05fdb7258cf8', '6909c4f2-9a67-4033-840b-4b53e9064f9e', 'site-2.example.com');
INSERT INTO public.certificate_snis VALUES ('d3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'a37185f9-ec3c-4bd8-9e85-6b8bd7bd99ff', 'site-3.example.com');


--
-- Data for Name: certificates; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.certificates VALUES ('43ed345d-5199-4c88-a761-ba4ddc70b212', 'cb880720-f6e4-4621-82fb-2776eb8007b1', '-----BEGIN CERTIFICATE-----
MIIBrjCCAVSgAwIBAgIUeC3iJp21UDIRBhKlMKCxwmSTaZswCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSc2l0ZS0wLmV4YW1wbGUuY29tMB4XDTI2MTAyNTE3MzQxNVoX
DTI2MTEyNDE3MzQxNVowHTEbMBkGA1UEAwwSc2l0ZS0wLmV4YW1wbGUuY29tMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqzC9S/n4c4dBfqxf2FWXbj0O7vhOu3Mp
34KxvazuDpiU7LvamfRhAura3hMQGoB+9VJZE45Xik7rIH9d/hD8+6NyMHAwHQYD
VR0OBBYEFOhYw4czmedphWiwiPmXkU5jSaa6MB8GA1UdIwQYMBaAFOhYw4czmedp
hWiwiPmXkU5jSaa6MA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0RBBYwFIISc2l0ZS0w
LmV4YW1wbGUuY29tMAoGCCqGSM49BAMCA0gAMEUCIANFerKPnC9BgscdD9pcVMGI
jlKGbj+XAe2NngObmfkWAiEAlNoioigIue26aypUJCCmqYiHZkOEvtL0G/eQWNnt
pVo=
-----END CERTIFICATE-----
', 'enc:v2:k1:_wXFraVj5Bz7i0xC:6n_GxeVJAEvdRxWHxSguCKg_BsWxqYLL6mfHBEyCNpBe8X9E8LUCiOE25yl7MDqmwDoIBbNOSjqgvGmZSplizaZA4YpxXm0fDqOPy2DQYv4IbyEFSSIVHL_LY8sg4e1eLm4MKhCHbzig1iEvw0OWNroeYVOMveOiKcpxItioMgaRCfARRCcqtQQC1Z59Enpwf1AOjVn19NVWIdFTlOlC2aZADIG4ZR-rYHMLaeKqyRUv144JEzGCmEA2TIvjZ5P5sF6b1L5rqKRk7fZty5cfio9btzPNzoR0-L199t3agXCAlqa0U6nBPJBEaBGRVz-N7Q:1DBs4corAy54A6rPbkzUQg', 'CN=site-0.example.com', 'CN=site-0.example.com', '2026-10-25 17:34:15+00', '2026-11-24 17:34:15+00', 'F3:96:FC:6C:88:4A:27:23:72:21:6D:0C:F0:54:60:D7:00:D8:83:07:CE:5B:F8:63:BE:1C:94:B3:00:96:3C:F5', '{}', '2026-10-25 17:34:15.494171+00', '2026-10-25 17:34:15.494171+00');
INSERT INTO public.certificates VALUES ('355bcd4b-9fbb-4057-a650-bc575ff0b75f', 'f549c314-49d9-4638-ab71-b2a764918c5e', '-----BEGIN CERTIFICATE-----
MIIBrzCCAVSgAwIBAgIUDRsm5Tro/KkUjbTm63jCV2p1vZwwCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSc2l0ZS0xLmV4YW1wbGUuY29tMB4XDTI2MTAyNTE3MzQxNVoX
DTI2MTEyNDE3MzQxNVowHTEbMBkGA1UEAwwSc2l0ZS0xLmV4YW1wbGUuY29tMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE/B1acjhvMWHHabWvT98Yx5lypyqz+Mta
BPzav9+Ber/c8u8OsXSPrfnNbBXHi1SJ2piKvXULl46auYWfdEQzgKNyMHAwHQYD
VR0OBBYEFJCchBhdjojAfio41h0AolYQFid9MB8GA1UdIwQYMBaAFJCchBhdjojA
fio41h0AolYQFid9MA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0RBBYwFIISc2l0ZS0x
LmV4YW1wbGUuY29tMAoGCCqGSM49BAMCA0kAMEYCIQDDfICOykSNXv/hmVZHnakJ
ExXrq7BVXJ1fcwgxQqxSKQIhAITEqFXtmVjF0+2cPcLKyjz49aAGjaV1JoXsOn/1
GygO
-----END CERTIFICATE-----
', 'enc:v2:k1:kwcyVQPj0KaZZvpy:TNP3GMde8tsbPQ9e1ZXhi8qQYDRfGxz7zXfm_ptVflmA_4i3eRDo384wQTYEUvwbWkKxLdsRVRm-9Wjd5c294z0IKOnZiMErmlRqe1yJElFNs1dChRnF_lhFzHYb2RjO6uQ6Ti_ZzLaSIIAFoy28E-3al-jXedvXmOSRuG9eYVdUTg2FjD2bWp1wUwXoncX3r45PUAuczyZndoi66VYLeJ2F5_KfU98OpaLxR8RhFJfgHwnKeJNj3f-2NP_33TuulTDaknKbb68hdPWO6cSW_E20evCS80dQFzb4MwRf54IYkUTe-j07NQ2SSSYp2p1fbw:8Zvw03liRj1FUMvfrFvQpg', 'CN=site-1.example.com', 'CN=site-1.example.com', '2026-10-25 17:34:15+00', '2026-11-24 17:34:15+00', 'C6:36:77:04:E5:17:ED:17:70:25:9A:59:23:B4:09:31:B0:33:F6:AB:44:50:8F:38:9A:7D:C4:CC:37:8B:5B:8E', '{}', '2026-10-25 17:34:15.845646+00', '2026-10-25 17:34:15.845646+00');
INSERT INTO public.certificates VALUES ('6909c4f2-9a67-4033-840b-4b53e9064f9e', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', '-----BEGIN CERTIFICATE-----
MIIBrjCCAVSgAwIBAgIUXO1sAH7RYYBYfKtxyWa/5VpCo7QwCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSc2l0ZS0yLmV4YW1wbGUuY29tMB4XDTI2MTAyNTE3MzQxNloX
DTI2MTEyNDE3MzQxNlowHTEbMBkGA1UEAwwSc2l0ZS0yLmV4YW1wbGUuY29tMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEf6CDyeAzNMjYDUGAVFbbI7EVQIboOT4v
6t8gcPjkq9s4nTYwbwaT7ah9KrPotvlGKU39Ut28fqIi3tT0AFhYlaNyMHAwHQYD
VR0OBBYEFOSa3Siu18O8UkH/jUkQm4bFFCnsMB8GA1UdIwQYMBaAFOSa3Siu18O8
UkH/jUkQm4bFFCnsMA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0RBBYwFIISc2l0ZS0y
LmV4YW1wbGUuY29tMAoGCCqGSM49BAMCA0gAMEUCIQCySfsufwKs404WP+Nn9nA3
18EBq8GHxfpnKEGEtN7MrQIgD9JG4q/v5Q1XUTgE/SPhEDgfHUShrh1KvfXGVoxW
WXE=
-----END CERTIFICATE-----
', 'enc:v2:k1:Np1QDmXBWoJaDcor:_nHq9RYn1UU4sGBKF0DKaBqimm2DkplM3YExXXduA060yImKkNtWMw-ay09AS1Rjvbw1JW2YryibhAzH2HILJAyKyQ8HPjhFN5Ld2xFFo4BYC80M8RSjN6S33Mrq51TZR3M2rq4-7vUurG6TOUtaDJGmqMDHQwMTLO4JK1IUZSh0b1sQJ3pS0pri2tu-IYGonz0wexmk5G5AoyiQSy-N2IkAt_6cb3wSmbjphyJhttx6HAjD8owqSBuWxGGjoKXubzbv-GWQgvB7YRUSul8o8THT0OkVN8aljdqmbnYh5sTFoQkdG_ak5398rrwiulysiQ:NrRXuEIP9-WqHcyyf6OgYA', 'CN=site-2.example.com', 'CN=site-2.example.com', '2026-10-25 17:34:16+00', '2026-11-24 17:34:16+00', 'B3:A3:BC:68:2A:F0:67:41:86:89:58:BB:EF:55:E9:20:24:CF:FC:C7:6D:1F:0A:9D:B8:61:BF:4A:F5:DF:E0:A9', '{}', '2026-10-25 17:34:16.107971+00', '2026-10-25 17:34:16.107971+00');
INSERT INTO public.certificates VALUES ('a37185f9-ec3c-4bd8-9e85-6b8bd7bd99ff', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', '-----BEGIN CERTIFICATE-----
MIIBrjCCAVSgAwIBAgIUOWOnNJHl9kd7fS1jnuH0kIzOKSUwCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSc2l0ZS0zLmV4YW1wbGUuY29tMB4XDTI2MTAyNTE3MzQxNloX
DTI2MTEyNDE3MzQxNlowHTEbMBkGA1UEAwwSc2l0ZS0zLmV4YW1wbGUuY29tMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE15Ngu3LirXmpI1kRYFR2nHA3bN0j0DQA
Wg0s7M5rlLkJJ95pRn33KybaLB24BwQCda8j7qYhplNzE4xNGBKqkaNyMHAwHQYD
VR0OBBYEFGRQVOKF0yoJey5onz/86lsgh0VpMB8GA1UdIwQYMBaAFGRQVOKF0yoJ
ey5onz/86lsgh0VpMA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0RBBYwFIISc2l0ZS0z
LmV4YW1wbGUuY29tMAoGCCqGSM49BAMCA0gAMEUCIBtzwuQJMzwZcE1rUImSXVWV
PuRPlGcTH37ThYlCkFc+AiEAl9rxzAQu43GslEo7O69zE9EIhvgbBq5ULm9RQFGT
Nfo=
-----END CERTIFICATE-----
', 'enc:v2:k1:kF7XJ2PRx0UmCvIG:40AnXWVqcGIbx7F1e1baLFnZifVievPovefLYtVpPToIgfCGV4JaPA4u0uM6Z-tI-bO05uVgKjhG_2iMWacTcoREEHU9eQk0X7NhfNC3ZiWwzqJ6-6Gmm1-2Fw_w7aXk6VTUXR4JK3Kv2zusd9v947bpm3vP8RZH6M0AJo8kp6PzMcbRUiCmygN-xKd4rYLmRL6jvZu-vh3M5rmP4hYJIQRvUg78e83J1A-zSuvMSMSxmZGepqOxUAjRujqSC6vAMNZj2Uxaz-xOJvPHZ72_EI_3uufkQWJjZMckDQbWpMkmTxrUdmLcDpVRaJrJBASutw:xGkTYflD2xW3lqWjUR28ZA', 'CN=site-3.example.com', 'CN=site-3.example.com', '2026-10-25 17:34:16+00', '2026-11-24 17:34:16+00', 'DC:5E:3F:CA:63:AF:F4:92:F9:3C:77:D6:EF:6F:E7:3B:BA:3A:EE:B2:D3:F1:1F:08:E2:6B:A6:B7:57:9A:C7:CA', '{}', '2026-10-25 17:34:16.390622+00', '2026-10-25 17:34:16.390622+00');


--
-- Data for Name: cluster_nodes; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: clusters; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: consumers; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.consumers VALUES ('11d3bf16-b7e1-4533-b6fd-a9f39e96416b', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'app-sky', 'sky-1', '{}', '2026-10-25 17:34:15.307234+00', '2026-10-25 17:34:15.356324+00', '{gold,readers}');
INSERT INTO public.consumers VALUES ('333c9c1d-8a03-4b1f-a62b-f2f8c07f7427', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'app-sky', 'sky-1', '{}', '2026-10-25 17:34:15.673326+00', '2026-10-25 17:34:15.739589+00', '{gold,readers}');
INSERT INTO public.consumers VALUES ('bae6f5f3-ba70-4785-a8a3-9f8baac9755a', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'app-sky', 'sky-1', '{}', '2026-10-25 17:34:15.989037+00', '2026-10-25 17:34:16.027594+00', '{gold,readers}');
INSERT INTO public.consumers VALUES ('e41005c7-6431-4ea7-814f-6d5a1b8743d9', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'app-sky', 'sky-1', '{}', '2026-10-25 17:34:16.269252+00', '2026-10-25 17:34:16.303505+00', '{gold,readers}');


--
-- Data for Name: environment_roles; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: environments; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.environments VALUES ('d3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'Pagamentos_PIX', NULL, 'manual', 2, false, '2026-10-25 17:34:15.140681+00', '2026-10-25 17:34:16.428261+00', '2026-10-25 17:34:16.419127+00', false);
INSERT INTO public.environments VALUES ('cb880720-f6e4-4621-82fb-2776eb8007b1', 'TVRO', NULL, 'manual', 2, true, '2026-10-25 17:34:15.101897+00', '2026-10-25 17:34:15.562308+00', '2026-10-25 17:34:15.562308+00', false);
INSERT INTO public.environments VALUES ('f549c314-49d9-4638-ab71-b2a764918c5e', 'tvro.', NULL, 'manual', 2, false, '2026-10-25 17:34:15.112219+00', '2026-10-25 17:34:15.896667+00', '2026-10-25 17:34:15.885929+00', false);
INSERT INTO public.environments VALUES ('26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'api', NULL, 'manual', 2, true, '2026-10-25 17:34:15.130392+00', '2026-10-25 17:34:16.163725+00', '2026-10-25 17:34:16.163725+00', false);


--
-- Data for Name: jwt_credentials; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.jwt_credentials VALUES ('aca2aa08-9d0b-4e0f-b9c9-eaa143425dd2', 'cb880720-f6e4-4621-82fb-2776eb8007b1', '11d3bf16-b7e1-4533-b6fd-a9f39e96416b', 'issuer-0', 'HS256', 'enc:v2:k1:2Ko4NTRRsywQp2m4:B49OtbP6epmhR6eri-Tct9lV08Md8nuMf7kIg6b-Xq7BXyPpEx_cDcpTYA:35nLLUha6fYhIDf8-h-ltw', NULL, '{}', '2026-10-25 17:34:15.331409+00');
INSERT INTO public.jwt_credentials VALUES ('f6b2688c-0b73-437c-8f55-15f74c9658ff', 'f549c314-49d9-4638-ab71-b2a764918c5e', '333c9c1d-8a03-4b1f-a62b-f2f8c07f7427', 'issuer-1', 'HS256', 'enc:v2:k1:iYrso9K3GFizxpe8:WxTxie0M1l-Ihi6OpUSfyCCMrwrnVDl4-dlrohvKxuL8WwQN6xeXZDxyeA:eIddQprZ_UbuUv2qosQEoA', NULL, '{}', '2026-10-25 17:34:15.711849+00');
INSERT INTO public.jwt_credentials VALUES ('8acccf87-334f-4eec-8a30-a69e63e5237e', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'bae6f5f3-ba70-4785-a8a3-9f8baac9755a', 'issuer-2', 'HS256', 'enc:v2:k1:dZKQwWtL8eu8VbhQ:3HXVN2HIOZWsyuJsFUlS2e45hGgNXePmUeclT-sSkYHzyVwdAzOc97QF6w:44F20k1KRPWxx5aMFN7CAA', NULL, '{}', '2026-10-25 17:34:16.011007+00');
INSERT INTO public.jwt_credentials VALUES ('a07c9f1a-3317-4d21-8148-f53083577e2e', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'e41005c7-6431-4ea7-814f-6d5a1b8743d9', 'issuer-3', 'HS256', 'enc:v2:k1:Yg2LYNBTlldd7APJ:OeCI_i4e4UyGZO8X8cp8ZAtrDOw_hkNZAbiGvuoLlgipoAPb5hxMjxClNA:_jpe-_HYCLiLH4XcMGVhAw', NULL, '{}', '2026-10-25 17:34:16.285993+00');


--
-- Data for Name: keyauth_credentials; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.keyauth_credentials VALUES ('d6a93483-cedb-4658-acb2-2e4cce4153b2', 'cb880720-f6e4-4621-82fb-2776eb8007b1', '11d3bf16-b7e1-4533-b6fd-a9f39e96416b', 'enc:v2:k1:-fVuSqQDrL9Z9sKw:pVfn3ispNAYUqMScN-8DH8qQDTDABuI:qG7_8XWlgV5k5pt0n_3LzQ', '{}', '2026-10-25 17:34:15.317682+00', '6a26a691491dfc2ac68e0a4eba59d2496deb8ac51b02623a1afb6eb023bf3f7d');
INSERT INTO public.keyauth_credentials VALUES ('5e51d754-091e-4d40-b515-c2c01b6d8005', 'f549c314-49d9-4638-ab71-b2a764918c5e', '333c9c1d-8a03-4b1f-a62b-f2f8c07f7427', 'enc:v2:k1:8dQOEl1LhjHR4dns:iilHWq9DItGOClEk5FcANuAyHg8jhBI:1mRrx5wLWDitx8LoKXG8Zw', '{}', '2026-10-25 17:34:15.684468+00', '70d6ee65aded31c459142a5e5dd4847d22684329e346eb77b01027e6f474d09c');
INSERT INTO public.keyauth_credentials VALUES ('e5eea64e-b264-4f51-9097-c7ba95b3da84', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'bae6f5f3-ba70-4785-a8a3-9f8baac9755a', 'enc:v2:k1:QxL6Ld7R9KXGP5lg:7zciJq6cGISBsdIvzK3MxcJQcUUFffU:O8Lf9woyyznTkRE0rdBVgw', '{}', '2026-10-25 17:34:16.001401+00', '96a81c471edec153798159238ffd095b78efd06408099fc3afe9bd64dc592d89');
INSERT INTO public.keyauth_credentials VALUES ('3aba1cd8-b7ef-4bd2-a916-09fc91a234a3', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'e41005c7-6431-4ea7-814f-6d5a1b8743d9', 'enc:v2:k1:Vb6XPdiwXqXooB9N:WEJ7ToeQpUXEMPttlZGzLGlhlJXAi5Q:0tSUWXWtQm1l6EJY4h_sVA', '{}', '2026-10-25 17:34:16.277556+00', '1989d94e56e8576d260cd9a74ccf1ddf4b25c5f0e5ac144f967174ed13668232');


--
-- Data for Name: login_attempts; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: plugins; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.plugins VALUES ('7bda90ca-e64f-4330-8644-e2e0defef56b', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'key-auth', true, NULL, '67e43a90-cad0-4848-bef8-0a09ad977bd9', NULL, '{"key_names": ["apikey"]}', '{grpc,grpcs,http,https}', '{}', '2026-10-25 17:34:15.382448+00', '2026-10-25 17:34:15.382448+00');
INSERT INTO public.plugins VALUES ('03a7bd59-b272-4f28-be88-69179e382ccd', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'rate-limiting', true, 'f9c5336a-60cc-42bf-92e8-f7070bef02bc', NULL, '11d3bf16-b7e1-4533-b6fd-a9f39e96416b', '{"minute": 10, "policy": "local"}', '{grpc,grpcs,http,https}', '{}', '2026-10-25 17:34:15.408763+00', '2026-10-25 17:34:15.408763+00');
INSERT INTO public.plugins VALUES ('4e9d952d-3331-4677-9f5f-4e139428df04', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'cors', true, NULL, NULL, NULL, '{"origins": ["https://example.com"]}', '{grpc,grpcs,http,https}', '{}', '2026-10-25 17:34:15.435155+00', '2026-10-25 17:34:15.435155+00');
INSERT INTO public.plugins VALUES ('5659b8b6-fa90-410a-801d-da934b6079a2', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'key-auth', true, NULL, '9777d00d-97b0-4631-906e-9f6f32a637c6', NULL, '{"key_names": ["apikey"]}', '{grpc,grpcs,http,https}', '{}', '2026-10-25 17:34:15.759663+00', '2026-10-25 17:34:15.759663+00');
INSERT INTO public.plugins VALUES ('7f329bca-a9d4-42ba-925e-cc2ce2d54d38', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'rate-limiting', true, '55e7b41b-a3cd-4697-9975-a9736d73fa7a', NULL, '333c9c1d-8a03-4b1f-a62b-f2f8c07f7427', '{"minute": 10, "policy": "local"}', '{grpc,grpcs,http,https}', '{}', '2026-10-25 17:34:15.781964+00', '2026-10-25 17:34:15.781964+00');
INSERT INTO public.plugins VALUES ('c37e25e3-7e45-4f7a-804e-698e62721f9d', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'cors', true, NULL, NULL, NULL, '{"origins": ["https://example.com"]}', '{grpc,grpcs,http,https}', '{}', '2026-10-25 17:34:15.808957+00', '2026-10-25 17:34:15.808957+00');
INSERT INTO public.plugins VALUES ('f1d0edef-dfbd-4afc-9e1b-373cb2b35326', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'key-auth', true, NULL, 'c0ecc470-7d97-4d0b-9012-4520952c2790', NULL, '{"key_names": ["apikey"]}', '{grpc,grpcs,http,https}', '{}', '2026-10-25 17:34:16.043638+00', '2026-10-25 17:34:16.043638+00');
INSERT INTO public.plugins VALUES ('8a679557-4c0e-4492-be03-4d10e910a31c', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'rate-limiting', true, '9c85e098-29e9-4699-9ed5-dac54c2ea9ab', NULL, 'bae6f5f3-ba70-4785-a8a3-9f8baac9755a', '{"minute": 10, "policy": "local"}', '{grpc,grpcs,http,https}', '{}', '2026-10-25 17:34:16.061576+00', '2026-10-25 17:34:16.061576+00');
INSERT INTO public.plugins VALUES ('eef738a0-54ac-49ae-84b2-2413e579807c', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'cors', true, NULL, NULL, NULL, '{"origins": ["https://example.com"]}', '{grpc,grpcs,http,https}', '{}', '2026-10-25 17:34:16.081011+00', '2026-10-25 17:34:16.081011+00');
INSERT INTO public.plugins VALUES ('cfaa5a9c-a841-4a22-a51b-f434af751919', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'key-auth', true, NULL, 'bded781a-77ac-46a2-9551-8ca1607da3d0', NULL, '{"key_names": ["apikey"]}', '{grpc,grpcs,http,https}', '{}', '2026-10-25 17:34:16.320665+00', '2026-10-25 17:34:16.320665+00');
INSERT INTO public.plugins VALUES ('bdb37912-eb72-4bd8-b24d-837725c3b48d', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'rate-limiting', true, 'd4daa7ea-6696-4a8c-8525-4fc140c910be', NULL, 'e41005c7-6431-4ea7-814f-6d5a1b8743d9', '{"minute": 10, "policy": "local"}', '{grpc,grpcs,http,https}', '{}', '2026-10-25 17:34:16.340545+00', '2026-10-25 17:34:16.340545+00');
INSERT INTO public.plugins VALUES ('8aafdaba-73b0-4eb8-bd48-61b7fd76c0a5', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'cors', true, NULL, NULL, NULL, '{"origins": ["https://example.com"]}', '{grpc,grpcs,http,https}', '{}', '2026-10-25 17:34:16.36587+00', '2026-10-25 17:34:16.36587+00');


--
-- Data for Name: routes; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.routes VALUES ('67e43a90-cad0-4848-bef8-0a09ad977bd9', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'f9c5336a-60cc-42bf-92e8-f7070bef02bc', 'with-path', '{http,https}', '{GET,POST}', NULL, '{/orders}', NULL, true, false, '{}', '2026-10-25 17:34:15.27388+00', '2026-10-25 17:34:15.27388+00', NULL);
INSERT INTO public.routes VALUES ('edee4706-74b9-4fa7-b4bf-94a631384c4c', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'f9c5336a-60cc-42bf-92e8-f7070bef02bc', 'full-path', '{http,https}', NULL, NULL, '{/keep,~/regex/[0-9]+$}', NULL, false, false, '{}', '2026-10-25 17:34:15.286355+00', '2026-10-25 17:34:15.286355+00', 3);
INSERT INTO public.routes VALUES ('a8fd56a5-1de8-44dd-a5e2-d2b1b7a68776', 'cb880720-f6e4-4621-82fb-2776eb8007b1', '89848d21-0348-4c06-af01-29dd75339d3b', 'host-only', '{http,https}', NULL, '{echo.example.com}', NULL, NULL, true, true, '{}', '2026-10-25 17:34:15.295803+00', '2026-10-25 17:34:15.295803+00', NULL);
INSERT INTO public.routes VALUES ('22ccbece-d4f5-48fb-b499-a8b85b35c449', 'cb880720-f6e4-4621-82fb-2776eb8007b1', '89848d21-0348-4c06-af01-29dd75339d3b', 'later', '{http,https}', NULL, NULL, '{/later}', NULL, true, false, '{}', '2026-10-25 17:34:15.528852+00', '2026-10-25 17:34:15.528852+00', NULL);
INSERT INTO public.routes VALUES ('3d95efc1-e261-47d0-8a32-25747bab0998', 'cb880720-f6e4-4621-82fb-2776eb8007b1', '89848d21-0348-4c06-af01-29dd75339d3b', 'draft-only', '{http,https}', NULL, NULL, '{/draft}', NULL, true, false, '{}', '2026-10-25 17:34:15.562308+00', '2026-10-25 17:34:15.562308+00', NULL);
INSERT INTO public.routes VALUES ('9777d00d-97b0-4631-906e-9f6f32a637c6', 'f549c314-49d9-4638-ab71-b2a764918c5e', '55e7b41b-a3cd-4697-9975-a9736d73fa7a', 'with-path', '{http,https}', '{GET,POST}', NULL, '{/orders}', NULL, true, false, '{}', '2026-10-25 17:34:15.62859+00', '2026-10-25 17:34:15.62859+00', NULL);
INSERT INTO public.routes VALUES ('c5a3b4b1-ccf0-42a5-b61e-90275ceb1687', 'f549c314-49d9-4638-ab71-b2a764918c5e', '55e7b41b-a3cd-4697-9975-a9736d73fa7a', 'full-path', '{http,https}', NULL, NULL, '{/keep,~/regex/[0-9]+$}', NULL, false, false, '{}', '2026-10-25 17:34:15.637888+00', '2026-10-25 17:34:15.637888+00', 3);
INSERT INTO public.routes VALUES ('0547214f-b67f-4392-a7a5-ee4d0a3fce62', 'f549c314-49d9-4638-ab71-b2a764918c5e', '8bf24b6a-1181-4f5e-8c80-121de795a86a', 'host-only', '{http,https}', NULL, '{echo.example.com}', NULL, NULL, true, true, '{}', '2026-10-25 17:34:15.659282+00', '2026-10-25 17:34:15.659282+00', NULL);
INSERT INTO public.routes VALUES ('61a83b09-0187-4ec7-b781-9574cc27a217', 'f549c314-49d9-4638-ab71-b2a764918c5e', '8bf24b6a-1181-4f5e-8c80-121de795a86a', 'later', '{http,https}', NULL, NULL, '{/later}', NULL, true, false, '{}', '2026-10-25 17:34:15.885929+00', '2026-10-25 17:34:15.885929+00', NULL);
INSERT INTO public.routes VALUES ('c0ecc470-7d97-4d0b-9012-4520952c2790', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', '9c85e098-29e9-4699-9ed5-dac54c2ea9ab', 'with-path', '{http,https}', '{GET,POST}', NULL, '{/orders}', NULL, true, false, '{}', '2026-10-25 17:34:15.960198+00', '2026-10-25 17:34:15.960198+00', NULL);
INSERT INTO public.routes VALUES ('1fa456d4-ea6c-4632-8339-1b326c16a52e', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', '9c85e098-29e9-4699-9ed5-dac54c2ea9ab', 'full-path', '{http,https}', NULL, NULL, '{/keep,~/regex/[0-9]+$}', NULL, false, false, '{}', '2026-10-25 17:34:15.970458+00', '2026-10-25 17:34:15.970458+00', 3);
INSERT INTO public.routes VALUES ('115e8013-8fce-41df-8b6f-cedeef2d4b7b', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', '129e3112-1d28-41c1-903d-4a863779f778', 'host-only', '{http,https}', NULL, '{echo.example.com}', NULL, NULL, true, true, '{}', '2026-10-25 17:34:15.979741+00', '2026-10-25 17:34:15.979741+00', NULL);
INSERT INTO public.routes VALUES ('93387e9c-1623-4180-8fa2-c97be37e0508', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', '129e3112-1d28-41c1-903d-4a863779f778', 'later', '{http,https}', NULL, NULL, '{/later}', NULL, true, false, '{}', '2026-10-25 17:34:16.134833+00', '2026-10-25 17:34:16.134833+00', NULL);
INSERT INTO public.routes VALUES ('7715de2c-b958-4ebf-98e6-9d2cced4db2f', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', '129e3112-1d28-41c1-903d-4a863779f778', 'draft-only', '{http,https}', NULL, NULL, '{/draft}', NULL, true, false, '{}', '2026-10-25 17:34:16.163725+00', '2026-10-25 17:34:16.163725+00', NULL);
INSERT INTO public.routes VALUES ('bded781a-77ac-46a2-9551-8ca1607da3d0', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'd4daa7ea-6696-4a8c-8525-4fc140c910be', 'with-path', '{http,https}', '{GET,POST}', NULL, '{/orders}', NULL, true, false, '{}', '2026-10-25 17:34:16.230321+00', '2026-10-25 17:34:16.230321+00', NULL);
INSERT INTO public.routes VALUES ('a09e9d02-9631-4ad3-9aef-cdf235a496a9', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'd4daa7ea-6696-4a8c-8525-4fc140c910be', 'full-path', '{http,https}', NULL, NULL, '{/keep,~/regex/[0-9]+$}', NULL, false, false, '{}', '2026-10-25 17:34:16.251298+00', '2026-10-25 17:34:16.251298+00', 3);
INSERT INTO public.routes VALUES ('cbb6be06-1963-4941-919e-a924ce386e7d', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', '7eae504d-7fc1-4d55-a521-8a2f05285c95', 'host-only', '{http,https}', NULL, '{echo.example.com}', NULL, NULL, true, true, '{}', '2026-10-25 17:34:16.260115+00', '2026-10-25 17:34:16.260115+00', NULL);
INSERT INTO public.routes VALUES ('53933b6e-85e3-4d1f-8b5b-6f65c9822608', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', '7eae504d-7fc1-4d55-a521-8a2f05285c95', 'later', '{http,https}', NULL, NULL, '{/later}', NULL, true, false, '{}', '2026-10-25 17:34:16.419127+00', '2026-10-25 17:34:16.419127+00', NULL);


--
-- Data for Name: services; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.services VALUES ('f9c5336a-60cc-42bf-92e8-f7070bef02bc', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'orders', 'http', 'pool', 80, '/v1', 2, NULL, NULL, NULL, true, '{}', '2026-10-25 17:34:15.233932+00', '2026-10-25 17:34:15.233932+00');
INSERT INTO public.services VALUES ('89848d21-0348-4c06-af01-29dd75339d3b', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'echo', 'https', 'echo.example.com', 443, NULL, NULL, NULL, NULL, NULL, true, '{}', '2026-10-25 17:34:15.251928+00', '2026-10-25 17:34:15.251928+00');
INSERT INTO public.services VALUES ('55e7b41b-a3cd-4697-9975-a9736d73fa7a', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'orders', 'http', 'pool', 80, '/v1', 2, NULL, NULL, NULL, true, '{}', '2026-10-25 17:34:15.596808+00', '2026-10-25 17:34:15.596808+00');
INSERT INTO public.services VALUES ('8bf24b6a-1181-4f5e-8c80-121de795a86a', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'echo', 'https', 'echo.example.com', 443, NULL, NULL, NULL, NULL, NULL, true, '{}', '2026-10-25 17:34:15.611113+00', '2026-10-25 17:34:15.611113+00');
INSERT INTO public.services VALUES ('9c85e098-29e9-4699-9ed5-dac54c2ea9ab', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'orders', 'http', 'pool', 80, '/v1', 2, NULL, NULL, NULL, true, '{}', '2026-10-25 17:34:15.942841+00', '2026-10-25 17:34:15.942841+00');
INSERT INTO public.services VALUES ('129e3112-1d28-41c1-903d-4a863779f778', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'echo', 'https', 'echo.example.com', 443, NULL, NULL, NULL, NULL, NULL, true, '{}', '2026-10-25 17:34:15.951009+00', '2026-10-25 17:34:15.951009+00');
INSERT INTO public.services VALUES ('d4daa7ea-6696-4a8c-8525-4fc140c910be', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'orders', 'http', 'pool', 80, '/v1', 2, NULL, NULL, NULL, true, '{}', '2026-10-25 17:34:16.20074+00', '2026-10-25 17:34:16.20074+00');
INSERT INTO public.services VALUES ('7eae504d-7fc1-4d55-a521-8a2f05285c95', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'echo', 'https', 'echo.example.com', 443, NULL, NULL, NULL, NULL, NULL, true, '{}', '2026-10-25 17:34:16.213181+00', '2026-10-25 17:34:16.213181+00');


--
-- Data for Name: sessions; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.sessions VALUES ('0049ecabbafa946e5a02141beea6b176097f636bfe8f906d5ab39f0d092f7ac8', 'cbadcbdf-b591-4d95-b97f-ba3f00ef3724', 'AQT6wp8xQNFS6M6Kmd6xGGXKeiQ_XKkrf4XIkJ3xerk', '2026-10-25 17:34:15.078303+00', '2026-10-25 17:34:15.078303+00', '2026-10-26 01:34:15.082+00');


--
-- Data for Name: snapshots; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.snapshots VALUES ('cb880720-f6e4-4621-82fb-2776eb8007b1', 1, 'sha256:4d45a6e83cbaa1800630cf412fdd4dadd214113e42f96401a48994e1a5a7026e', '{"$enc": "enc:v2:k1:_XZPeFzRtp7U89wK:LR_n-3CWeUQWrI9-DTqDNRUiEd401D7NtohiHm0w5RB4YkLjJOFudSa3WvoGFPiYNAiEyQCB2N_f3JNmJjAnEAACl0tmbAjsPy2moc6Ic0q490htWYCafRx543VVbV-xHFmnnjU62t71lOJxLJvTu1ANmE0oJU0fv8rDavwVz1pGl8NhZZm4drfQyBAZOIpB-h7ogvPARU-7F28e3BgebWslPoV6hd8g6moDzDodlZylbKtO7azukgu1NN621pc733BM6O-mBiDzVf6tSpK8odQaVIMdDUXEcCvddccI5FfOdRpukoqv4e9H4ZLoZebC2GjOOR4aFGUg5bGG6Vjf3NwNTO0qxYJJPPd4Y1UdmicCaJ5lJaOHeWooyDbcMzAp1KezMPbqlSw0WnfCwybF450-HBT20Vwy65jM75bqCLoXRRhJyleVF6T3KthsXSExyA_0fOnYhrF24XhTrwUCtnV-X5m2srcFmOk70thfZuAcBPHle_8TXe84kkqTJSHv3ZC6dRCcI1m-ZTqApF6rCM9XH8yvfJKhiYZC5rnIRbptScmvUMiDsEJ6KmohbuKXUJ76EcCykpxNsiuEe8IXORXKdlL1HdzblD_PTDXvn351TkgduSXaDdooZWTkCLA-QZKHOHoFD-5Nl78Igc9ttinBU6XRaETB8w5354RSEhDU0H5OQnFj3GySNTW0rdEsbVBlMFF-q2VcbmvkuzG7QcXJ1wSoU3cGUSPz_18x7aJ6_DcVxOowfcM7V45qFQ2t3ZtsSF793QfIhObaxWF3Z-8aV3-Y6Y0181mP2axC7G4NSvYEw-4926JKYFrymrEERnoVuLqbs1QuqnbJrx_Qoqfg4Y8wyMIjOhQeKAuwhgUK-nu1Ca0c8rIdpYMPpaNU_qnS-9H_veTtnAst9oLWTjNYg2eWBk0i-jrSbJmibTuMECuThli3h_Ix7C0F-UVTWYA44UAHFqsloaI4Z8Oe6d9UzGYsA4FgruUe3OKZ0ot4wehJ58BhS3jFqMfpZW5AQ3VjgVbmDKrM5YcAKKGDJQhPctC7WOMR4pf1Eg9hlBTqS0ZQ_PHuKDY3yyMMv6zztpyYOp90KVeQROLEu1tf1ZUeZQ_CzPXA09RsIsVy3dOJPz7prrUxw1rMibxR68rLY4zij3bLV9tkTIQJJXe1eVutcjbGKr7w7QXtoSyWKxPv8ZfifxmoPcdylarGL6qbKUNNy5i4PMMeufk5XsWYafBaeJU-2ge5RmVGwrS0nyGxk4rJUn02Nb9jAIGUFvHspg0jYWlpDBIIrqQRKxiQKn1GXbZb9XahC7gDx8dsjsDnISOUU9LonqOciWgO93lfd7lVA2v2H_NupN1wCXPnWdNsuzuQmJIMcRj-RS-JrJNoan-8o-XFlvXiYRnQLEc2xShpk3jeGho3_wLCmm7Q_SsEMau4Thj2wvnk-gKKrWhyUKgU2YayiSQ10sNj-kHNpZhQP1VX3bgaZNwuXCFKgZJwVpr816p4Cv5e5nTveGCku_U_amb-dxziJqnahkXEAoB5vPkxR5Bzpvu-EJVUfloBl8gk9KJELinJ_UOA8mGAr9av0YHzexRiTT1OTDivAe4vOTcWsYOq4cJpusalQD_jbSw6VZ_abpr6xNfVQRRgcET860J6glw0QELJmJtnax42JUCCrL6lSheS9rDWKmAY_B6cs-kep5eBhabbI98BURKMrFi1Sk5zh7gZKmb0Az_-8uz18MNZdvdq8UqqG2p222VktyY7v0kXV-cUwD4IfhohRzGJnICFPm47M9xNVkMp0uk0aj8bHUWIq1NkKcTzKuSQY938g6bcVc4JCMNOpQrDvBBV7jVKsDriB3UrbSWkgbGZ-Vc5MDJZ1ZdWFyzmPQ0tKOae1nlZqcTLc962Rcgmj7SCBCCcsD4gHtKqcFJh7Foi-mSmmtTCW8yz699bZGOg97Q0n5bFFOVFjtTgzUCsKpUj4Jb_FOvdkDnXhiMxWE8uD_0rJgUBRUVh18S79J729eAP5puhE9DLz8AQy5F5RfD6TJ7SnPeMGs5sEYnz2U5pHDqKrS3h4Cwoc1j5TaQHcxDMuUrYHPzJajTPN-Q5pfWQ0cpkm62IvWmxDqzyq4PJmS7zRifJNyTMKizPPOiDMnhNgBXdMwXKpOZs27x2cb0ojZpMBiH9brdGpBdyIJVHdYg5XYIFpQhiExumNfF1FUio1RA6hYfy205nB1ABsQ1JA963Cbkf2b4sqkVpjeG4v7ALEx8lCeY0eAb2IjKvWe4NdSRmlHfWmH2KM9gWydHclvTiWjh82HSAPxlg02ZdrE3pDnLUCXKDWyHM7mQrYTKr7Im-XYn1jYtzJvr-aOei7rAiuo4bY8VGCnNMsAAidJPKRMIauK9kES8RH-1tG66S8vjnp-7UwHdPxsMtovxKEGWgrDxDye_tJhPTBccqkVpZ84-Xcbv5SKsRDCS5KP3leS-81Lfd-RBf7EzDA7OrIabejpWuTtuoYGajtKxh6AQauqFxqIL0gbf9dKyLYAoiM6W8MJkf-iXxyKHsXyUBrXTiVx-5VREJv3wk_Cvf89Gfb3jyvCtUbU1xs8zuEisiIa9QbZOif6JrVAizdLrmRKTdCuf9X3AyASwFXgKXJM2HXa5rCHNls2pka9LA7rcmNqg7SbXpFG1BI0aZEdNTUvoMYOTnCwt312rAvskmyhNtBjYn-MQxwTxQS6BEtg5hQsgDpyx4iJN7V64Dp2cQFEtQO-5NJ0G-RNCKCPmiSIgEa0JzcKj2lqQ7wEEFA7KbPIunzGvZ6kK0JKUmXZRNGBi7NBN_seMAnnhe3aTlaj1VOkHFR4L94vPWib6Vb6sdipFC1jR7IUiYbA_Dm71VL2s5N0gkLhhu4dmEDU7VgwrsodtxUzKr05RYX2a2DzLqHpAvlOKJJ-rqxUVhbt0KNFfHjdmwTTE09YotEYBTCiTrKs6lBHwFPQynYYq2QpJ_KaxCIFhavWU5yYXj_NFWA-3793dZ-2Ggk66_c4vL3iOwNs39WBCKuBjAQaibs866z14hHIybMIOOJ77Z8sss9Nx9nVf1LcQxnzsR_EslEO2UeakqNOqiOAkV8GFioNJfKGPiSHMKACA1IxLwLfz6AJfVRciSPJCCv4u_2Siu-l0J5TspXzDG3KKCsgtRaszR8NxMxS0JXQ7BuEuHHy3fRwgGxKrSfZfJ6z9O3h7CEMJIf8fWF5vmVymizoc3-zBKUhDdbt_l6rUQPnO36RAwuybZj0J1jD5Ewm3wbDLUhzicd_Mdf9sTK11q14V_SLjf0xi-wq9lqbxwB8CSw2qSe4rmP_jOqzorgonqpRxiTAnZGjDnqA5Ewdb_jmbKOxmXw9bKD_3zQ3nMV5IPicHBuEkBiWQtdIy8MeCQP4TfzRAtsMKCLpsk2wW_ZjEoDKFxfMCGrUz25FX8DX6CnLHx-qnEmGvkj_nLq6Mb8jYzx5hrWXsI5EY5dvrSrt6og32sQkjss55uUQGcGauWhasg19F1Bb_eMM37E7gMkjynoY6W4YxvESZA0T8LfaNJR0MnueGIQonOZyDp0iZE5avw0IjU6FlKEFRM4sNoREI0rjuVnejnzJ-mjYz7uT50AQ8FfaaabhKE1vO0HnEqwkJ-_wrWzmJIicZ43drUfzL-v8i5Vxdu-s0xBeELTQs1y0ZhFmxQJl20-dPMYlHgn7O3fcIjb3XRsU194j4I0TQgqH74iF3DLV3b1u4UTpaxHu8-E4sTPbIaTRDhcKEpzUVz05MsPAD3bJX1aSTDGT01IjkpUHlpwFVe9s9RCeBYNwpI9ZRHYwCaVl7uQ951EQGk906DkmozC_TcHoSislegL1jgmcA9zTBT35q-avqQxRHhF2NWJmVIbVHvIjnjXZdtWWdTw1Uhx0cl_hgAdsP2NRfCujPIsU3xUfSJ9RXIKn13DNTv1U8lfbhCrsKKXsgF4DCCE7MW0qXfbZeKUSRZERsAJTaeboXkNtLAdodYXwmNJpuDcZlEsJ_0ijVSOA46ZFx9T7QQG2ZZOrdB58dGEAJHlCeHmI_8Y64bwYLCyh5RxVnA_vaqg5351UuarGtb2IsgwryjkriRT-pS-1lp2Rix2tgDtgd9tYF1YPxsEGmdUin66jgUjOR9jVhgXVmaqZMFxj1ABgaIUzfMdZyv-4r44hetdLFZAhwiGyaTaYdBhpKfgyxrSMPE4hmWaoCVnYPLOx6pKS6s6O6QLkw0b9EvCGyGZq8ndG9LiQPW-9rXg5uoySj1YhIDhwITueCLP-jeVqKf1ycDx_Dwixf35mXFYfFTW1Mby1V9_Vopj3AGuDTvZ2AEQAH561RZjxNyuCb87AeD1ueQnjZgdD-MYYTj73nVVqjq1kNsDcfEB_Z9iSuhJLi9ksyrgxpTXCWaX_jlB3-6-nsdyqN1szRRnxzxihAtPYLnOp63sTtekabPDkmOwECpb2xL8rWzu7Vn8-FvGEdOuxDbJPPtfnfxQvseTCCbb8WPxyYBYGrhvSEWUytJysYVZWXCaObdCJoH_kkYz2pS4b3_Bs2LXiyKfRRbwENm3e9cJ7EkeD0JlZHdLbYWUIUhWzbkvf4ezfceYUmUWKpcUmqVutNO5R_HykYwapqBv8AdFGAuurFPuvmTf5NxOWm_tobmhQGsJnNC-LlzMWYJpXbGePebK_WZaceBEZ2f_jpZ5NObZjHJ_4UlJqoQXMvh_XPtlbtrPWZ2_s0m41NYavZTkChGW9FQBhM0IjcN6Uglic0HuHWSahYTx8khQzMo_UGacvTlqdwiRzjK7zZrFy3vfNbN5BaytgAUGb6s0h-IQq9KJRGbRYYNopi57Cz8ho5dPMOEyObYyBMuJzae3fi_Jc06VKk1qxxQkNemGQlXbF-lyiWnJN8owJQcBzSKETb8rxcBmtyEcEqglh3VapIDEs4ea7Jt2J_uvfnxWdvMk98H5sqzQS2U2N7vhV7HV5ZktoBTqkP0kY46eqSiKLmB_bibjzXjOw58GX7KUfwKTUQyCt2cLwVrvcw7G7h9Po0qych3JqAletgJSEvIbvkf9-bost4RNK5DEL_wa7oys1sqne_eSgA1QUco9m73d1t1rKCx-HCIf-zZrYd8jXYklFfKe2NRi8gzQ10sLjCj-TBindQ1YoIpSCIC_Hrz2Vf9YgQXoWIplpP0UGF2zvwryolbzgtTG7MbFNDOi_HbRhQX7l8n_Kuljty_-aKVZvvQTGgZ36fJ5JUiFzOE-sLFxWpQg2srnB699Rnc_AyzkrLr2_IRIU8psp_T_2E5722nFA92Y8ON1Q_g8z1RlZKPwZgAy0Y5fcrf7XnZDkGyqSxerK12oKjii4VKg9ncoesdnmlhlco9umFlOIa2xO1ljYWiY5PMQpV0R7zD6G8xr4se3doxLap-u_Wn2tmwtAMI_9SGzZqEmVKPqa66XPNoAmBdPG7LQOdwpja1fd-T_wB2g7i63DyAxQ1QXd_jof9w-xyHBwzNUsr0o_b84oGvJkJa2_gdrqd7QAJIhx5qdsNNlABuVeke3JSCO5WPx8xbHMkXg-sOYn6ueK6TbySy57EMdZrjlZ3DsRJ4e-udZ0er0scwox8-mGf0c_VwKWnxOPamw8YyUv6Qe4AQR20f4EWLCpjLRuiFXs6UvAFW25e8mo_Cqo0m-5cMwUstycbt0k3cIQ0Sf3cH7RgcS74FdSjtIDIHYwZQe2kfZjlvnHNq8rcYYlJmlNbE-mDjkA-tLk01lnYqBwBTa1iIPfsWOPXjS7FZGv__Fb4v6A15jo5_YcB3RwOPLSu8H6y3w88SCKopoDuOOuJBCMkdqxYfTfVSVN1ucT2Z3fVBwXf70td-cxtc6p5yXetgk_x56pFpOUVN6P5fUZ7V0gUZi-L6gXjTHUTU8k8Kd6Orvilma1QqmuqY66wKuqlagyfWK1ZF30Pn4k6Pdt15oluOO0u9GMCGOYl8SDnivSqXU3fZ-ScGykkFXyigiwm1SFj2hoKXPEPCm5-Er5XsJlWDqngIdtLrIAhiGNtvNYXoaPHYMBPjlltAlx1aaHqieXFhaz4585WhB86QAg9FZ8qjnLTXs7t6pEOSYppkBNJStQJuyQshF9hK85WWRyrADKR0inWIk5OGHJxHpPWK_QsBWa8PcBm5x_wNuCvxrrIEd4dfd_X7erp68PAUPa1ZZEP64RDDOn23HXBRj5dgmptk9pUubDIcqo9ll5cwxq3-f91HF1bSYiqo3JwreJqEaprLw25ceaDK_6H_29njANMMw-CSlectqcEafYDYsQHOvixkDxq2wscitbNE:RTOnzNh-LsTOR9MLwbY_dA"}', '{"$enc": "enc:v2:k1:6P1formJAFfjboCe:CW-DTX1wkNzkagUysnRnj_wHp79CD7kHqzZhAgvi7cxyPjk1qIVOrSWBHuZ0EzJ9DtycQBo9TGZycyOT09a_JfPmJ-xSz43elUwcelEka5HZ-dtSv18xws5NwCSjXjhX-eowLEh7smier_iEm2O86jHAkMonEZcTO1g-YAdhPKVafPa7PPx3q4QLLSZNVlQBXau0haMqpT4IUGcphdg2P3xCi18L27POW8WYOzmExTwA8JytSsGfnZjorbWNMFjiuypN3s4x8EYEDDUZgHVM0_KzRqrmHo_Dk8YbvZIUB_aQb14v4xVlWGj8ubLdPw8Hynpq3bMruCZWw_5beY_NW0D3FwJpl0jDsdDXcVg1KQ4dpNUlRHEa9SvSx3H2nE12l17AI1_9V0QJAEZorlaQ-7yuhkXjvWKlRhS8eqjLjpXSO-gXg33PbtfBmbrI-9_8LQO-fnBTPJ_5TNcmoBxVU4LMUum3nlnvI39_9GtF7cWX233w-De75VQcL8JkbVMmv6A23tesOwMskG3andBogeEmNews9QNNIvlBcojWCJN_D1a9J3ZJYuWioVuwUhJo_4ymrgrLI5l561sSG4UsCB9pc0DMXloeKsyldVS_gtFcbfNunWC7oXVxprsFIJzB6MAfdfTtjrwjz1LD_B_IrS0AcZKlFJWvvHjgRmqKCYowP9BOb8wgrfFVGxRDM_B-T9zPJAmK2MPx6gxrsRkj_675iC2Lx7BydnuUgK8-FWfxIwunXpmQC2uqI2vn5n3RGYBTDlT1HBq9jb4qeJ6-Np-eVT0izMgy7WFVYdhbjIieeBksCGl6pSwd7qTmiAfHtH0HLcMJsH3s3M_GSq2Ovw1qhEWmb-A3S-bFD6Tp_JrigB9zMk14cqgJ_J7gNEtNIt_0gZ667jAniJPB1XCs2r1pH5wWfJ32HboXM8XlExfzACW1j4XgjeSVM0xAm_895gThswMMe3bzreN1Y9kJjuQHHxbHHfOPE8sMQxNGosWc4SjG1W83yMyJ0dwBLy7mw-xwFd0S8S3zgUvSzUXmDZ7S3kx8MWGMXkE34ycbCowaSwEzmZS_MyFIk3pI9F14V96jTLhetZpdTaP88VICzrqh46Q_G9xt0yMjAj6eB0PtaEJqouy9zCxJ2PGoWPzoOx-LGdW-PnI5dEsPE9yRXU9LcQznEnuH5AQo3qvxi8EZaqtmCIbswlmq2Av_dBPT3tZgCcwahQc-hq8KwtzG0z__IqEOjn3OqbBIGE-rDrEtuwpsWLZ1c01dQ0Bfn1Rw3R1t7CWdy79gLTqoEpc18jTpdi9StKLAKKv-sIVjUd373nrH0t8F-FX4sGTHr4bK7VP2qFzX8wteuEn5ZYltz05g5YxKd8qDSwexzBxHW5-RJvluLWYN6GEKlcyc-ssvF14QNJ9JKpg5gagOlmmzT0Aa4C3NBIoiB1Qmbivil_Y2IwDUPOmEQvBQeg-_rKe2g9ko7z6_EdrLUgT267rXfx_cktBLz2RlECa8lyIyVg7BYX1BwVdv6ECpTpl4pL9dvaAu-ZUA0p6eaGlt8wd3luW8PEpeFKgy6KP7G15-oZp4sU-aGhWYtSV3hE_y_qhy3xo4rKiL1T4cRrgdyx2bssUVeEHZ0atno9MjHUB2gCmc_shBj5Uq7ZCIWGsqNU0NY3-00Us5oIIkWSXRUrNqYC2hVZBIdXCy8KeJEdcFpWLbWFmoRAGC6o1cd495oceFVIbdg-vqipljVDZMgbYx_z8ZcctOgRCyqfZtJp8hrlBEkXr2QuUVFD8xu3aosFzsAusubiC0M2y6NxcEMJft8HhaDpDXTsSb5Z1Jrd5GQbT_gfW5iT6SB5Bk6w7efuK8vUeqLvUdlDG7e5rSxvFAIzoc2rHUSVcBQ7c4ktB4fdzrsGhQMEcaKQeRImZWbG5MpWUc7vfg6J3jLVTntb-SlEEzMrE48vYHBklISC6C8pG9PoDGMLIEe26hxjfdZpiL8b91vioHXPcpXNN6nSJXUSHlSj78kqa5QL8Qyu79-ltxrmUCLx7oE4_dlcK327qSao-khBNYdIb_Tl6nt1XO1YQDsy6u6ogl9pJf8Fy_9GKk2jCgftjrqNOLg_Rb2XB0LDPkdbok-wOKwM4WzGJfNkn-bFXXSQ4kvO86lAQNV1WYgodvRhtmnevaGY7KDtoJoMnTi0pGtXzcuWIwFcxtY68YkAQI8PefQqDpjES24Y88OkF_AQ6_0b566d2zxozqfg8vDCklNrBw5f23XMnHnd-DF995jYKtAgyHVlFMDKlRlp-M94TmXa0f-NzyHWWDdr832o4T5xq-pzSXW4Bo6Wjgql3KuVFFTwGiHnZrR_5iqblvPsSo4t0zU5X4WE4NOdpEJjS0Yy-4CB_DwbAYG_Kae4BlWxQGWwDicy8kvMloT4Ty22jSIfpY5V-Y2OVHbwTPpB9f1kgoiS9nlrD97B6ynYDaNIt8Tk0-EHVcQghgm91Mj9863g636pCnPGP_HlODCVVaaoVkgVRwEHMwqwXSUXjOI2N0k32wjLj1o8hNw8E41UBj78ltrh0a4mx6NW2HiW0kfsgm-W2xKzyRG4KmfV8B-MdPcmomq2uK0L45GU9TD8AS9DbHx2Yz0iAcJwgdhfr4op96M9JjtJEK3IvfkSnI5aKguXOqiKg8F1Nj47SD4nyhyO0jsk46YpQfDiLQK0-NVgQ9d28Y9wnjNvkaFLX0WIiPfl5WQ4CQmIITns6c2lZY-6rcbbpZz7c7ujELtHac47xz55DBlTaiKAHFjfbiSHkppLoyucC1T41nGFFBce7Tb2r3R9aMTo0wGpXgICAzoTtqZvVvw_X-ioyVamkgEt9OuFhBAJWdCxMVWrDWvSBXrICuCq1WDWKaPr8QsT7cfv77_7DJFNJ7qwmGzNX9N-u9aHTdf1GlvjZX1-JzUqjPe3dIvYQukGXw9Fgi68tTjpInIhQMZTyX8jefEIQ8rQtu4SyEFdZv6BMB5QAPQhZAYdoyaorkEOoPcRSFaKAqBVImymQKkrIM0muuchSMGQAQFqVfxXy-qM75BaxBjJazDLvVVLFf9CBF73tcHX435-GTk8yjtk57inApu2eS3wkP5ya27mgk6xJxB6zKh--9SwwF5x40oAZduj19Nhln6ICSqprlAANpvKvLt484fKmSSf9thnkfNJbqADiHYEuhnu8FGThyNldFjLnhV7Ri-GfgaFP1e2hThZ3POeWsMCEphsoful3Snb4JXoFFo_cVIRkCeivH2wmNtDnjELfu8MBKby3r2flWPvsiYuGntmWvRKuzux5n4q0Nnqbk8dZLkZSAmsbOPD5BKVhKhcYBhrrZUXKa5OpFn4kD-OgyEoi8Oueu4s2E3PdHCSsvFgSe0xZcQigl-djKFGH4CJAWeklIoLkRtBu9HON9-n8Wq_dZo1EnM5vxHnu06byzvR8ZunPPzGiJl0xC-vcV1ye3_YPjTvAdvq_2KcncRQsEy-KW9c8tL-d8ScwGxU9DSUycaFqWd3gEmvFZ6OnIzfIEb2VXKEDVU8C8Jn6IXyZiExDzUnRrdYGtHUCDBr3caD8uU54NdBzv9yWMBoRh6nsNtDHxgAqQEsJokUni7FWynf8Apa5eg9o0pgDy7L0oIv3145Ax_2E0NOy1zI1U-KtP4-_MoXnbuBoS6pQ3gGnOmu8AnkMuqdRkr7mewB9J-WHxeTcdOCdWxh4sMf8YC0b8RmjAy1vF_-uptdzm6TLnHjuLEmnkbi-YsehPD9BbrHkUQKDrgGKT3Pub2WDzFNmcJNo597lgQPoplkQcpBE-9scpsmq9x8tu9ZFcX1nrhc4_bnUt2E8xvyWmm4duDhWgscch7qP6_s8QB5yTWvs_w7J4uKzOy5jY4onW6P1PXDhR2ye9_dglHmMSwCXQCqD3Ng3JymtoNmHpUUdyp2Z6BeDhJpUdes-k1_u2AsaYCZvYvlI4cjWrzOkbofNATduGIDq1IfhgOkz515bNAWQCo29Z-66i7_kcVTDgtjxXsTVQFOOLqfDjzFJAaU4sK9Txwz3-NkVl7K7CXYN6dycxoryX1IkB28EiywO3G18PuaCCJF_9Sf4iOEbkp9kwBi43n1zY3hkPluGPb9NJtE5BTjZl-27clMzj6j94lAOHZWmwHS3FDkYptWvEaaFEA4yYw87MJ6f_VKIWAMmAGAATWtFinx2DWrGAz8SOj1u0edHTXGCTAjQvcf8ryEy9AXlKO_PjGwb4nUJ1gFIuk2WIoE_7QifEHTTe_pWqF0k1eyz4EjSLxh1PoJalu-ySBHRjKC0NrBhmGypUSYLIlSrxEih4Gmj1R0r9SelBNGUunfPMD5lzuObWz4JH-8feuoXuzykfVtbaeOz7-gbKAeua-I9EVwCnvZHlka5bPXqRRpZD2AXGzIFXxPlYnuapSKycxkZjiTQhf91_MDh-y1fqwWT1evGmmfuNjkUrvxtk9Dl58Tmq2JP8x4bvd2Y1ASO-PDt36GFN9rYr-GF3baIh9CRFoqjxcNakxalhk8E3_UczludjsQ4N4YzVJuuEj1GmDNcpv7dTbMT1M71jP6myXdVsSGPv8oocOGEs8oT8u-49bD5_flui4-XSFx-M9dw0N8ErzOzZrwbN6AyNl-A0Pio6OceD-5Y1avD2XggY-rJJ1r9pCZxK0rqo5HIAhhGxF01yXtCWt-tGdLm_9z9szfS2yR7nOe2Lh8yfeHaso8Cfs86EZK_pTNyXSsQQhJQOA43ide-xUNiIk5Yyl2QtY7Df8OWzda3a8Ix9lJldKhl3boTaBcQctr8dC_7lMD5f3Vso_3T7ufQDUn7iqohAWIVxdVeE-qQfNYn6PgQydBi49W9047ZEQo7TQN_dloLDngxuHrUi_8qbv9gWNb7rji_ZDftzdigp4C7DoWFg4aKy_wwzhKP7OC_eqzr8WQOTFzDn-f9mLspb4S_MiPSxwOjM1rdJn8IW_XE1SH1bAJaBNun_A_lbi7yHhq32yTV6mi0Nvbmu9-TGnOCzAl8N8Tycft1gdCBX-gBv_gnJH01z2Iy7QZpJ8W3SSGTVbO_V5rdelZ1_PdCvBxvVh5H2wWOT6wKcdozsRM62uhBT-Pe3-WPmsWYMYSbsSS7fjHhlfZ92twilANuTeW15C_x9kPNI0VSQoxJ9RvTtmVaqQOKiES7phqz7JQ2C8m1E0QzJFpXGWQt6HzF7gAlqnhBtqcNmX42RaPm-eqIH9OCq60U6U1JP9599egYG8ujIbDwczFSgvk3E8ePxyj_NDAFJkN99yQQd2nxAQuK4lsu5a77kODNKZcPMoFDsbXg9inZyoqUbB25yu6oakieEZ7yD6J9jQNBEug3SkftocnmGgMSK29eDI2Q1YdlHdwh2nTBSV1oHOzInv1DAt5a9aItVxTc35Q5MKS-H1GRE7JzFucY-V0oRqJzlNiAAT0WELxzuJyqkm57IgacOw1bcs9WKhCtmLGu9wMXy1vf5r5jTYqyR4C3v360dDj3XS2h4i6ZNPs172KMP3VXkIqNsh1l1GDqa7ypVKsyKT_F_Or0pvxLExk4WCles7whBV0gx3E8jn81J3KuZl2BauM5bCj20asvQoWej-5-RQg92suHV0GyhcO4ijTd2WSTZEEXgMKAgBSV7vN9r-1PEM-_KA3cmFy-SO1C5ua695w:Gw71-vcGrWriclFb0S5lDA"}', 'first', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', NULL, '2026-10-25 17:34:15.517+00');
INSERT INTO public.snapshots VALUES ('cb880720-f6e4-4621-82fb-2776eb8007b1', 2, 'sha256:d857b57b25c4cc9754ca7e94e45d9707a21c0f11d6210985200f3076e6e7c86c', '{"$enc": "enc:v2:k1:tS7oQyzc06qNITy8:wIA2vWzh5fHXRZI8eSVoo7alnymSmHmvqtYO0YxR_qA7JZL4qMqI_ajULr7de4k50WoNycoUkViOjC7dWj4poAJPtaifMdu5AXH9Bt5ybqYbs76Xy2UShhnLPDUb9emoXLSZ9Q3QrLOb241lqVP9jxlqI__lZODhsrg30ILaiJ-PVSG4bxN7LqLv1wAIERcyPnzsgN76Yd_S_UyhxJQ-pWP7-XZWR8Wnlr-7dMqUf_1ntly52TTZAcb7gn3hReWTx0dxayw-OtioAoSalCPUg6L9ypDNuA97Hzb0XlVNjlpE9-h2-CwSbvNEgQ7UxsYTUsCDMKXlo1mSjDx4DwLRxRHQwbgp_mQk_daMQejk3PG348VdJzHv2TVCO93mvtM-9jbdwy3lmGfYLG2QpRBdsFX8ERp1-958pO_OLFFstz3_SNWEP2bN3oxUl6eLSgxs1igvYTlJ_obB-opsin68KgfsHSYv6plGncwKKiMgmfsMJJbBykSya33v8GtLGd0A8z8jD7gW2Erzm27503Bew_Z366tUBqKRd_fCsnDHRSjFm1tOqu7bBnLdH3N6dV70ZNO1uryLkNNrCK2isQzIJPvw90mu2Q9DaGQdZNDOQhUDuuvei6TiF4reP7NvGQJNkAn-aQqW0Q1HslTmewv8J1lriLNZGs9L9m0bTpSUfsHf1PQUHa3Ok8E7XWpqhznUwqQByxV8YFKd78z08PPzJJjWgi-nI72TPlddncFu06SfN2T4zRr6-_LMLc8f-7B82ukOs6FvWbGirPwt74pQYaJ-wQJUDERiVUl6_JNbeuzhWXIC6zwLeIzJ0PjOkACj06AxHdn_rKeOpT3NCPRS8sEsQwBjSzRxRSHwsUK4RRkKB11WEzqpG-0uYtafQJjrSujHdGRMz4JpigbgHxO74sbnyUGV7c2uJYoSDwsi_KN_mY3RbU2U4jBRwZ4PlBWHuL-J_9S_m3KUfecHhsRpq9mTKK5wL1gg6KSUGSnVUfIjIVNaVGjoVPUyd64xSITPfj9zP-bwvR5e_8j6puEyEUOjkAyoPzMuyVy-n3u-8uAE--VRN1fQ3RmM5Go8BcXEQr-ZG98nVytUID3o4LpbJ0a6KNBkkB8oUrzaAYMaW0Nmpei38_1kHsXLhHuiUEwoofo0uU5q4L0Xg1Egv9Rl2Fnrc8NHlFOVDYI8u93_f2M-LuhrCEOqDNlps6mJ4qDzMHXTajGl7x8JFWgFAMwKci-RBEzkoKlsZOlf44y2a4QNFwcXIj8kM8QjX-vAKAqy-AlRen4VA_oT5f1RQ7__tAOQ7xkqgp6LwZ2lV_NbTHk9VzN4dVpJ2zLRh_l1KnHLVr8WuTznMoOysbnucI4wJDsV7retCwmAI1ylTtFDhSa1c0vuPsXJ9iKKkfTb2hN4l6a20sce13szgGiYL0cT-wOmrlDHkDwJoNsooWMfpOoyaxaCo94GCfsLJf9epYWo3C7rdnKELn03_NuQjui3pu0zCd5GXVtzgy6MSAtHkDnTPEMJkcoc7u9mMijmpR5aKJ2IasBvLpUsUaEERHCM--3WJERe3rTkhPfIvMW4-aKdUMBuL5tJEyedujwdSWA6-UAPovetvRLhlMWOJ8-98J9rGsaxM_RdesG525uD6lwTn0_vhK3mhYDqF_5AFNKF5n0UutEHOCaidWzbZAa-QMnXQCtnEA9wEtLdnbm1JTu-EMIfndrb70RJW3RoaKkd6Qx6cSwq4qkSY8M9c5xcwDAiWM18eXZXulXv8p1NDULom2_e8QFnvJ62V7_PbsMdPz7nhP2iJHlynfMYSx54BWBZyYLwIjS6Ue-DESo6SjLS716Xu1w3Li_ou0CEZ4mXoF0UfEicCK6VE5nfvf5FxG9abcHSB8G6W-gRbbRtke1e4IOzcvnBiaseuU4yYwkT0ue49PlEbMrlzU5RmLyZW2LvRchP_bi30xWPkQp21IIQNQlNJUG66Mo143dCjUV7x0Ysf633EIQsEPbfFvjlUC1V84l_N1XrZAoadJYaJz6BEod1GWqNaqsEk1mEgo0CNhYq_oGoe_p2kKmgXn8HtglvCCUYahvIReNHKNYOQtKBKBQaoM2fMG0vTk1sBU2OwbNTOB8eMBKbU8Xs-Bit49nTkotFBReqwIXHFIMb4w0_F7s-nsNkswKOeeb7fmLCfG2Yfjlhz9d1wn0ycRbwWPNfCMFwodfHFgtLxhWTP0vWsRXA-d5Io-3Frs3e--oV_wXqROx12zM3zYR6ZRaD4VyjrsTrFSzm5iL7h3DllwxzJht0ZyJCKDX1nCACiTdZioeCh3zjNHt7ljiY4p90I6l2tIgl5lAOvaa7uW7RWRajJuysw3W9zfNNo2rUsz9CZavVp5RHdw4iC_iSGJJfaQoM0mgKpmJT0EgkS-UpgUmHJjl4sotcyHVOqyRIE8VeAB5s0VlUX9k2o7e7TqU3FvFVDe5SLYsbBqI9txLgi_mipJTr7DWQzKSr0G6rxRY8r-hr_m4mOp7gIa6grGhq4slCqvkwtNw5ExWiJA0CpBikqJNBXRPjQOA9x0prpJyAodDgx3s0rEx2RZxQmjI7lI_H3rCb-Cgft40tZ0LSzrtLy4wtXedXIhQ78ufQCqYHrQYd5zw4yYD0PzmWaht8yMASQ38ZG-_YVWQIKN551H0HTfollAGvkyyR7Z0w7CsbHNB6QVDSgRptYW6VoR9kPbdTHs9c5hQ_6zD2EtQDfD0Cqn3h5kCegecg1xBWnGU2_haFJwwRR0WwaEvbGXnO1WG3oTlFB0jF2oYb3gJWOg_okGQPeIlj40EUH0VlcXbNQiZ4qVEgtF11XW5ToGsGUVqRzNdaTdMXQUdMrMTjr0DxLRStgwDdXc-Oi816Hz5qX3CtHl05qLpy-a7RsU7GtfMvzczxCnBIBQGjSR0KjL_0gYzrl51k4x45DcbN-MqbZ7ZPR-p9eYsb_6SO7UU3EKMIllvPk6oY9pLLq3Wm9mbB9h3a1QKmivgnIxEIgfE4OK4ULCBbfB5SXWxZxLaEYLnWB-9kG7ufWHEX04V2ANckWutFXB7e8GV_hvtAlR27EYVkzUXspiWtY9WLxLa0IpIT0dgOBvQZQ915g0u9fQR9HUwa1iiF7gXkaKDVx7qtmFSs_EBDbc3RSgw0cHiBc-v4qkvwgT3LpO6pZgHpUZB7Joryxd0ufikbucIvTs6NOXz6zSPYKyh4rt32dubhy-9fZ_dHrfzoYUGDvl3vqLQLkhV5C2cHAh_EUP0rbaOxTHm5J6zw4NrFISa6s1E2oHihe_KForRQ0gnZWnEVknvLHyNYzMvihR_rp5av8b_kPTroUaIOv4aEJ9Ko3ukRVRZ_Xc7tWGlkWpaJR9QI6asOP3OjfJRSmh7EV5BqibFjLWCwJuShCU1G73_mxuyj7wSAzXsN449h9l8jYRcCO3iYpx3IctEMahzhmzU8nJdbMo8gn3WfbxAzrYz9MSmMsIWcxFB2PBgcVuE29WOnoyCvRI02MEjmdnqG9cI-2BrcT4BB5zKMzH1rFo7nW4sH0E5eSB8l2vmg3_PZkERzhHSrXoF9ZIQhrBPxySp4h_c2A_9zFV6cdOxuGI4tjrNdnAh7_PSgNaWgIqYzTyBROb-PMQWrmERW9VfjtQNQbnDkQulrv63IiGoZYBHMjSo1pWuFiUz5oDq9kE8BbenE6xVKt1EQJlwNmKYRGd7zGcI8fWOL-ktsie8RWFHlO_ZC-PDp7qWq8AmiITBvg4fGM_dsxqjI5dcftYeH3_zhgKsq_PfDQn-MeZHYkCLapzBo3M5XEG75ACEqjrpQSaIrnXHTx4vDaEiR1NqmUEhnp4v58MPvKSmz8sg2232e2zBveu9ehkTu88IgQIPLMQBuY6wdbCBmw7EZOXZTl6zZtpOCicJ1NyfRam_e1iSTYuNWCDOTk0tyKuI4_SrG56qecjI1ABc1ouhKUJJUbSCRJbe0ZivrvxYbKLdTwH7l8GLhesl64wgG9-PtrdmV7lPv3AnI3EGUq_zK0DaE66IJcTFxQpUI6cb7cESqqGhIkgfeNPlqfKLHIUxBc1beZHQggW20BxgXNJ0aZLgB-cbfw3cCTwfxY_QIRv1Dur3bR5d1nAFUrp0Zzl0K40LPrx7UFj76A-4o-5Njo8bLc_d6jYc2NWPXZgLMTVDb48_c6t3kRWJt1eYtA77AozmcmlhaY5-XzeDyOyyUSuH89Y6PvWG8aUIGN9-23kCCT4T2IE3Njngj_yku5M77O-pFjZGj1W7Wls9xTLJhkxMx5UDMYpwVnova37ikgOva7Cptkw8SAmMFhDefcc-_PkFcxFvHTTLcP5JzBV3AJYRKxQQM0LeXIjC7AZaPQisO7IYCRwtYEzn9tiLTYiWwK3dFtrn4O_Kwd4lAcHq5uoIsUFOkWSFYYxg9wym2Ihj4FmJUAZGzI0-GTIaY5MPm1XkC6ZRdqdD3hosbOMlEOOzCx0nl7T0SlkLwFq-Gg_gC2eE6ZFy2XrtmqY1SY3bHLwcL4VOAJw2fVn0S5Oleej-LaTvVJHvTz8ff3bSUD9ClojtVyzk1BOh8T2yFexcaZTmw4bBuKgjWwgFP6_WYv9Si0cMb2rayHGR5DI84nnaoqEpOGk3u42H52a3V8IfPPTukq3r639hOSs4t33FN8Noqz_OPif4qyJ_40Wbst8at5ubEOl-AW15pzJMlmoZwmEoMvZhnyZjxT8UVQJN3gtLGd0Av2Nkh1e00swekrluvoaOac1TQfdyHXRz7pqnEIwMiG-PimO0A6z3XB_grDLZ0UyW8pZvrqo5z7oXuVJoaB1Un8mPHeeUtMsYDAAvUoFuW51-OklgOc9IFnkipH-PYUGp4apD-9Lu3yswwPASk0QwFi--OClHBZA-_0zoHqw2aUXqY3fLWFWYladhpErcIrSEcT3nkKgZK1E4Q_Vdnn9ott3wqerXgdBDL8w0eI4CBbv5sUD8xvJGCeK9h06jDQHXX49tk4HJFPoKO1oBt5hWsAXyJfGHwrliXXdXnUOJRcMow7neC_rqcUV4zm0KkOltlRoqjyi24YHhomQiDloWWvCOH8sJTDantV9tZIADAdCrTHCB01d4Swx8vZfo5jq3YtMfIymDth2VkhXYC8bXlFmlg6WJk1Z6xBkKqbrLr-OTEGeMbT3o4Le8pNQ52IDclSEXchSfWjEvrx2geuIrBWzFIS35rwYokI_KZPlMa8H8QpDtrCi_mljvsHs9ZBohIjQ-IouFloI3sjI2gwYGgHDQLdGWDSY34DaxZeZXPCvGdutLqXlVIk5_8fj0vPh8uDNPq9_JWiy145yjIl___1-uE4z10xmDSsJQG2X9yBMimXbAJ9y1Jw0HojqoODfQmDhyn0gAXHYm4Epy79wdTROgbWMX0JygpmErgrgQE4UlZIRHIvKYj32QQb4QaephyiVp5guf9ggy1dmv95pQNrw7mvjUhyLwEsyv2SGUB0P0Bt1WHL-zzHIbEX_GPQSeW_Hc5z2Pvvd7OrEY3W2NC_KhfmlXy4Z8XN0VWGLWpGvEPyTESX5dIxCa5BoDic7JX5WMVqq0R3aBej7q7cq35zPmi3DWKG9uK728fNqA24CZY8C7EEibpDswHHZpbWUIQMZpnDTuby6XJVARbYJxt3wZzaXP-6Fzt82BYgplkxA-tvKVSva7WkO_1cHkYCG-g9KR6JK8WFwasV56qbUyrky64_NP_ztRmnRofoFMy1W4L0AuLkuUpyJBTGRuGzfcNa6s3f8gFyLaKu-z84laM2bcEcKmW8xruqQ68y-2MlXG7mB4KiPQ8Zccnc94cAnjGz8Wonz-Ffde6vfed_McQv2EiUHLry4nag1ss1BrMiVTD2WfgYDWLpgw755b7l6sPr-hnvb5N5BZ_WfBkElichDuJyoLzILhOWai-s-MJw2ppdKG7XXpOOA3crE55uf15HuqF2cmSb0FJY8KHX7orYmQQmX9GwUcaL0d08NxN36khXaJaca_EFPQX-BwAQEdidBI1xpORORM8mTncFQnjNrRuo5k8cfEHFp2qEsHaegJuuXqLomx5o5PA-V4J2aVTDly8cQKfX2_BmPgDZljghQ08yctQnhnmoq8EDjH7pdApUCS7V8ImTFVHB1RCcBWI1-q5nSmOoTibj19nsYP0xdR1c7MPBcHaodtd0G8GuBLSFtZNz7PnoIlmmADMBTEnjqwXA2FsasH1Oschg3bnMm9oTKgg4L_MhIXcaNGP9920QX75_DOmKKqBzVigxJ8k7QdaWdw5-gNks_R8nAh6e4lcIkS61wBObmU4OvsIdpY9lunL5nXb6-O152RJY1QqdjMO42VqXXrKFXqnVmPiLr6Pn7ysZc-g3vZMgEePtbm5uLJzB8r7-bK8VbbPj0BDknXRO4rzlABXcRF9r7Tqm9vUO_S1JePvGxwCLA1FCLz3lFfarMALtM24F4Ij70y5YAEl4C1FFBi_z818qOVUV8ikmhdWoipHkraG4hW1Ze6qGjjBAMDrDJDO_yvdffVYEfd-nLs21sbMnIjGBuY1Rhgdy0R10WhTz8ep0kxxHjcbsww675q0-VolhSW6fijv_FSr3fjYRJxlWIgYOEoP:zUiVDBaFu05n1cTEhjn1tQ"}', '{"$enc": "enc:v2:k1:l-IL6fLL_biihbbq:qdODIyk70F9pmq2_TY1qXT-1h_ZvxmbPrKaV90Z2w9hiyceVOCWzDrtiVVj35vKgA7NWkb0A6MNQqdh9geqj7RX7X4fLLYENFJf5zMMgOHTBl7i5LCuzvxTCoq9cJHKrEWgEGHF2ViUyzKbVIIZ5feOGjdrTeesKmtoy3DLb9Fxm3ZAwvTpewqEuqrJr-_Upm7ZS_ECWztaMgdMUDU2zNUOqWkdljVi3OSWKxDW1XUBWEd1ULtejdoHT5BtmPLX50Tn8N8Vk9vf1CDbd3me0NILplyChcwlsrGf5T1xhl0i_9M3N7TVesyP0-1o1qyc8aHRCQr0ztTUdpF4rpX4yNpiTto7GqMYILt49z3IYHD1yHBzxb-kwDxxEX2uhLVq-u8p8mwzhQC2KKco9AevHE3HplKXF173AQNqXX7r_m_E8jYAb_FmJe-o5dln3n7cdth2V4hfhGtlDSpkP-HlhuZ_d234MRHsomweHU7O2S_KSASoVfMk09mo_qN7RvWpxrmeSzYh0D2S_RMmeKOW0c-6_-wSl7FLzDVFxauUxcztN4W1mm0X8qI65_ksVEALb7amnH3R5VgX6v-4V7XeW234ga-t6XT8Hr12y0bA9LVkNTzerETtH8aLgZj-w5ABVPP2fp3Tw9DjGydDwulV5hspOP6b1fl_PPL7pOgjZMpYRGXTiXU4bj3p8Vux-Yi-9zx8QG-dkKhwjmquypyb4oYkrjQiA9BoxP0Op1b1ESsR8zQGvdQHlxBlNq8rMb-Eqshc_IQqfL4MYcYKeiH6jtvBTHbY3BCEHr2AnulQ5FzU-kZzcJNS2OKsnMps1tTOA1oM1SnVmlQsAkwmSo32iDRug2I-eQLPKbAYljVKxY86tLhu7jjC3vVZlGcUmWESZcr_rlW-uyfE3FakKCKeH4qt9mjTsSDcSxAiw_z33USRv8TzIH3Z1w3f5Sh10SeS9TH5kEPU0uX7huXJYQC2ezDdffGSK6qUcVhX_LtA1BldBGYPorKC4nBzm9OczAQixLLozjOeO5fJWBKbYwEQaRZUPKbc9y1L-ZaPpNYmtRF0JFtz0LfRnZxPMpr5FoUX0DHFAj35zg2P0_5MypD_ilJzHi63cQW7VqksNZ84MfY4SndwJlI0lhjca4mmQBJ4Vrx7QN4tCbI0Dg3uS9BAmtoiRyyrPJhEwb0-yW10MpvA3xl8QYG1juKHO2QbwmoO6mmbhfHuuAJ3wwQuua--9qlGcKGfnopYJHqnIzXdL6hyWip7rnjnMH6-fJdvaU9zGQ_wDTYy1Osy2sCmE-He8_khWwL9rjVntv1Xzz4mAUvnGIp49hNGkYFFSjV25wrDKG6_PoIFFZ4AfQtQNxPRUHoovyiIQN8PXj63aZgS_oer8Kt4TInvspCuSsTmFd63ip6A-B8d-3viEvVZSXfd9dNXVn72iMwhdyge_J87cDNFafd9FDrdP_g8CnZPQLOtBHQvxRk12u_U_pfcAnnuArfgVrbefPMysicPvVfmJW2i-nW9Xr873H2lJ9jCxI7mlx1TaXp7hbN9TJYcPliSySPlPtmcIugSUuWTJwQ4y1jBCtQmbXY5hShM3OvNXvRkWJECGu-PBIgKhepCcOoca2dKsWAU2lXYqmizBQ33eOHboBeR1FF_mIUPkLZKS8L4rMApi1iXIBy83sCmCh2P8iUiaVFwkXBlSVJ22f6qpDYebiHyPumlAAcJ1edfiLu6lpONougybrDHhLXlbhERndP7EOwtE3RNENUxq4VaqHpwjLIgBUVmQDSQNTVLTa0xLNAI3cJfS-MP10JQSBygHGVlZTiN02vmeVxAXjXAFw3B_teffzdQ_yvW7kOtnMQ-K38SFd4hmqPOR_ekwzIwA9P-LLLgEbzv67J6e6l8GLgJMNudr86eGnNeJCFIr0wwFlatgEWo8_jnqvzRt7QiK9PRubq07M0hnRz29NwkClAUhNDujZYjY99V3WkiT9s_gLBUnQ4KMlofQY_pxLm_3FVFOR27aPiworj03lb7zsnrO1Dv-83mAjU2VLzaDz2vTTqOg3iFibe0i0TDqvxL5LRa9-CnR4ggL7C1KOG2hAax6qoYMizDdmLY6n0TxcSXDIJvxF2Zbulyf49pufCEJjxwuGRhB1JtJ7axIrmBiUmkQBapuWAP5Xi0DbIL-oDl-fba6XwuPyrHaerqAZ_Sgj2cuwObuKrdrFmN2PkdPUvjYFFWoVhqlGcinLanZV6If1zZhD6E_mQyZWcZ0uv95bj6ynoiBwjoeLqRM0tFlpBpuf6i9zpJHStDMAvr1IU_7nP5fh0AXiY22kbol0iEf2F55jhBOONPQtRIifbqrq3vcA9ZwULSO0pM3g3gaVUzu5B1aim9zFA0mxy3IWJ4RbiC-6W7W8mV0SDU-DHD6Ryi8K-K2FOaeBrWNdST8CX6H_0iApTgw4JElbgoyugpR9fb38nyQ7YTgykJIkjW4gmBkzdowTgfwPoNF_RPgdZlr_D9cEeOuU8mZNQjK49mVpqLqEX__iM2oA0A-2lnb7T-0fQl5epxHeshwIvJwFRlFbq9i1n1w4b2T1MSlahDt1tTf7Gj5Kv7SmGD1fpnwwcrdiIK_mkl5-fKQnh3K9-bhZe7CELhJjoWUm9z4V5y51xtLhx4tdeWYkqTybW241N9_vlfdvmpgL5N5vsiIiXXgDfToy_9GjMbDufjzz4isFj4aqprSl5L8fh2IF4fMRR-XuUImTQjguGSkgQZg4GVRRKyOkyR36eI3wEySmJevZ_vCHqug6YvU6D_iBtd7urPu4rushcULJzuuQn12_1sUgFuju12PwAtxPWoNtATD9uRm5D8A0YwDYp-dPM4rFdFm1tXDbLzib8oPQX0JCRJaM2kQMfhc-FqewbY9YfHXAEe24T6sXmTbmj2SqlrKDRFovz_qVA84QgkDFDqBjaQnzxLR82_1Rff_MaGsGBWUwLCtPIpk8S3dCQ6qetWYMFfJx8IAjyGS-bh34WU4D42b066Pq646qE2EqesFL5ToRyrR-uUGghp7fes0KLS6Z3OlbBVx745-UO1W81UrGKJkDLO-oO4Qxqun43KC5SmgP1L436b03-pyOCs8rNFR7sgStkJTERnXXYuWtFI30WFixuKwRHgm15H_3CL4KYhsdaU089tKwhHd8CP8nV0-otUBqs4xCjFkURJGQBa85G2rzXFcYQsQhIFSeq3lk4JFA6VmPwYMlmnZuV7K4T_1txe7Z1W1XkcC3wQqvc1gncC4DxXPkKGnTZxw7nS5jGrzWihL3aEDg6k0bvP19vwAdVsdaakfuxnYV1mE41xnCTCRvlDHlQWFet3B1EoSw3NNiYCfT_cRPUgkEkvMy5xf5NmnpubnQKTOq5dapFnPE_j53p4Ss5pfWyYAflOOqjbr3Gqbhyuy36ZHVGdL5ee1JYKODfiykSI6iCVh8zXw6jD0el8hcsVNKAd_MYVCzjxYoZhg8k4WXgiVGhPTZz4fKkOXn7FV40nANuJuC6NUStv3vh7WxcAigdBjskxoekHriC0Tm-jX0g4jXj69dWLIE7y69KCK9ChuvKGBSedWEYDv6xNVnZJdkS0lAkwmQcOYEVdC4fK-TRisv0zkTFYwZyEFlZwosnJybhQk1h49bzRF1NbfAXhuP4l5415n1RfnfJoBQ6rMabunhosevQZOdpu3z-ItDovHWHb0xBWc7fOXyG5WzHlas78e_Yt2oact42mBKFfW2FsPlJZ9sol49OULRuSnWx87z1UV1OLgN9LYUtHl-u-JEPyBlDPTM3Tb4m0xIpLa-g7Yo5hJgJD-plgwM48YjmWUD4ZEQGWkYC9UMG42cjQf7ZeTnnP9ikCD9-emjwxsUSNWq4PhK4Nag7CfNXpZPgDNgJxX0b3IfkKoC4Q--TMDiIlYuCRLpARybB4qibFFBYWQc2XqBPGdu6KelmztawktnANNuClKUax7hdTDAPXhrlPKOXZ_An9oppR6_kTZ9pPIezMT1IDK1XzX9rJMsm83rsHvMZaWlj7FG-D2MNCkgEDM23WZsnRIBpRPGDUWBls08u9KQ70_1R2IczukPA7Th_lKdFfkjEldToybVQuYPV_LW1olZbyLSBGbfoLPT6AsvBE_vgeiJW1rY2mXMD8K3FW7I0EAe8U2p9C1kMG1ldRWKwII77IqCAAU6kwkXoC7s-L73fFo61PEqUYIiANKeSD17CKlZtKQo7_YU5kOm0dbEEonsqGSUbSFxzrxPzzdvgc4y27gGYvgk73fFgHncVY9MRAPgtCUO3aQOIKbxabrXuUjKVGtK7wp0LQSpAXjnskjfH4RAhznW5K9SATorFbaBh0v57MhLd1ap4IkN6X4WLJrlD4p3c8EoVoIYkf7WTemUJ4-PMllHgGwmwdoKpnirjELka6O_FQoJ9fMvjAbbA4BEJUiNCtrTvIaopua7FSdCXW_48_TNTdTiLzNRyttNGKkYXDt_pleAla90HdzGPxJa2fZg2wQqYHSNSJ_Ebb05i_odruyovCuUtxkqCohC4I27aQCI2_WyPYH_yMj57rsJSmwKy9ucInWcTOkWYeaSpygmWV4zk6AgKYYxQo0HH3_06d81WfqfOiB045ycXiRfJRVfSdciWC_iNuVZctMxY12TsTmeKgV9-DuVHy6WPXDIGl0g7SLO2_qeYcBM3B-5pO8HC33CCB-SFFMX57wAFS_-v-j7xz9PmMm4D0YA6miAsvJGPHyhV7fRwlWylb_CKaY2Czhq5GMedIDIrNocJ6K2-QCarhhvCt9pNzwx7w-8CaEXAlC_Zg1Il7eDtnPHgWnHIycISa49HwXCobVjlWaKV75o3JknQSQAI0BK1_etA4hTthrHTw_qIedycpwSqpGYmUnQMjfsUEiAWFyLI-GTE7zut-hVzSPMGepIpazWgUIiIoy-VNijT0zIEu5AIS7DYB3S1f-zNIOhYlCWNSlXLfrxDFLwVTPADdA8i56cnc5JpVt2x8YkLB0hiGA5zvCOVfFe5Vpaw2OzsKluA5aDJqq4Rvj69YFItacHyROit1IvwxQSSrLzOsKeKVmEKH9AC91R3OYBVRvw0rklZGNaO3UkctuJQ3lXpEXFNL_x7JBmGVgyNX-vCdIYGc0KzAETFkprgQ73zz4j45gX0PnJmentcHT2tpb-_65mejkueu6gM8yq1d4KMqcD_6quyv1gvyPSUxtd2mGO8pJg1Cy_WGfq4fe5up5hla6KKKQWDOmqJz_-xRTimjq7q2AoBGsJNThNwpBqxgAjbGU8cFgwCIyWVIrrQplc0ssD_mP5ryJV-xlL7HKJpHkPUQ7tN7Pn5_t3hEWgIVnSnlJq8ZRNw8bNlGAbXdQ9MNg-a-GtMJHvG9CutmMEIRmi_Ib-PNV1_T-uknd3GOaDckC1K-5tBAlgXxBSf0G1tQ4iSx_0opXcJ7fsE_x6XMzznZ3bSaFL1OF7roVhd-ntXTS4AsKGgLN9vPeS8kblp1qd7xTdWuRnqpsQU6knUqNcM_BxyKZ9AqDUY5cjH9gz05y8ybiYKEA4Xu8W0NvMXltqqR2sQYyYmfkfPOCMKNRJ42_MAK31y1By6w2kJ4naZqaIBhWJUQms4oMF-LHQkc4NEyrkQGMVOgpRgqv1cFNRNMzJCE2gpXANZiM2XU3kMSR9sk8F7iFk-ViZNYCn9xBxg6A-lVShJTnHpT1XNivMQ_pIHKWWCt_fgdyCO7qCIy4mog1o0hA7MgGLXREa4R72e2t3hZfkNtAMdQxJjy9o7rVXNUpBhIdJduLiYb5BkyWWqhNWHe4GdDTKWceomnl_USY7dZfCdcZh9hwQMqAesjKzoMwLeam5qQk1FKn0xorHbIfq2nnmx5eCUlgCgELXu6oJ7aKa7O51xlCQCOkxLB_JTr37j2xoI78EnbFkr3tm1Xc14KQ6ePlvOc7Rou-kKvNr4WoV9GnCShUtgs002OTTTSB7sFv_oT_7Hz4lv9CjVA:TLa7enoAevZ7yUz5XwK1qw"}', 'second', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', NULL, '2026-10-25 17:34:15.549+00');
INSERT INTO public.snapshots VALUES ('f549c314-49d9-4638-ab71-b2a764918c5e', 1, 'sha256:2e3ab3ffb8b9d350e8f80908346b58a69159e043fcee6b1b66b4551226c7056c', '{"$enc": "enc:v2:k1:yZBIAXf82cdEHCQs:l1q0nZbdWfOxPu8on5RRyl4t46FH33qJa8zyX3VAoMKvdlr61vlqnfOqp19lKYKEj_y5LaOd6rNKv3DHkR-QCTnbj_CCHGOvRJ_z6FktcUETh4xyFVAXDDC15CV78M_ji2UkjLAqub7pQl9YtsMKdTIl7r9BPQ0ZGJ0_inoSMJP4hyAWO6yB9iqoou4krMcq38YRghONQOTpxaq27np40p8Nl_X7QqMsnWAs79JDeMtlIgUKCtjwiOIMzk4AnDUdxckwitVr957JwTxwRP-cf1WeNFWCDCq5IyIe5kyRRuMdJDIRWTyNnRPnswFjM6LdWktm2NSlUClIJJw2m4AJjmwApkkcGxpk62XaI0MsHVG5VgiX7e9EuFoIkZcsRWyyGYo2bRRETcegV_6F3dW4BEBusfMUNbk_7NXoOmczNIDdx0u3bz817-EQDmaJxDYFPL-ayVCcaU5hL5y1rYVeXcOA5Sz34n9pBwchUR2SDSY_Kilmf7O6UleZQxZfHh0woVXvNM6nmYibDb7Ex3eJ1ZMrem_DiPTblIWw-UeLpcz0O43ghEciGbqGHvEcdt-TtocG91iXIlWUoGnsGqbqtzvhw05e6TrDQa42zfFfKaq7UN0RfMEKgLEXlH3c2AeYHnOfWN3JQOavEW_cneUb7_H8sQxtnAMND0Vn1zqFJkBwIcZEeSFy2poGeu_TpNRjf6dCgHhKlQhdEBBpz8ustO_RRddoSIlZ1_LfXNLcfT7baBzybb8fmeBmznQTZG_FJoHdfS1Z2xtpYpgfjnnGDdunrz408twBzTkuXJAZm2Zi20yijbNP9OQx-vtDX8rVdnApSLNzv_Olz1i2-9D98abVURVC4px6Z21yscY19Zp2hgr5foylIgULkz3oTyfJJO0N0po-tCjptFYg9Zh52Kou0nw0QpiMK11cF7daW1pujgP2GkMKdwvlPLSRxHTOsxVcGgpGSoiW8GiF2Cfc3LjTeiPlrYxP6A8qqY6Db-AjOxUT8tq6NDy1LMyBq-IpsF2LgI_iwd9Gj7-ZgVD0DrDPGvD9oLKaYsuVfJ3Uhi8Xrxz0DeFONuc8GRoER4zGh2117BI7eZ2912Hq-DFDV9IqZ-veBfyXJJSixOv6pPhTbUT1rSvNy1FT2Uij1mbTbNAJRXXH5sqa0iZ1lj00E8QcREd7rlPWHbIN9njzgk48li7uSagfM6y8smPcLDULflshibZNQXujoIJn2BFqYiXuAY42wzR5_w42RVmAdrAWFhCcFZN4KZanpWkXU4hXOD6z_0ByHvk362HRWUjBfPFPzMqdMxbHpH2nlD7QbfA6gTuPwOKlWgMRK-fQDggGTYKcvBLrBelTpYt7QESqpIEsdo3TyqOjduk94vqGwnrRH9ngPdBLXsDNtXpCKJ7PLAd4tfsB6JaECSrrkJ_-YKN9VXz8CxuV5_2V4gNeZJsnXjk9BXt4HaajIqxxUwq7joHutUKTGk4a9QeD9s--t1me5IKq5sfHUZDXBsj9ARInXkV1So1X26FzB2y5qMeL-dnjRrnitEzdznv4HSbwQx5r9VbNJl05XKDa8b9u3OmtSr8ytTm2HhTPmzHQ7FAQzRxcTpFFaMxbIfQauvqrYrkQPpOlNkUVI3wvitFKQCIVXf51VjOe24UdJeJD8aTCpkcz1guKccF4qqPso3OaLa-aflC8STpgeA7ktmUMeciAnJE1Z5XpQSuk4CTei4PrYSr_kqak9zQWW9ZlLFeCNAdjR4ZS2zkoFjBpdGLqtB0BDwRSXZVn0R8uQDp74lum5jlpOmxBsk2BrDNHRL9OM0eoOSzTAC41t-2qsnwgaFpSGxCC2qk8Z9YQgqNgO28aVwftlya369bgBiQqaYY39Zha6wekbpL_hiHLyMDd6ThAEtmOxNxHPrFnee_U8iartqym-mgo_I9SC_iJSNR0mSmlqQy1SgQXBNGgmkiimUvOLht8ic7hHzZLc61N1ifzPHnYSn5xTWC1AZ9FBVtQ4to-j1SROPJsRtsOMkyymW05138Iv3r4aQQwH8Iv3LdFnGeUb2YM-bwIVccR2xBrBoac2NlwlJzWWSKLbtLhL9F3aEE5M7MtJ41r4Fsi2fRkCHhM8OCUHT5NJwlwjXFSsqI-oWVGsobc6eW5xDuPDfyMMKVW_JWcBzY08AVQSc1bulNahKb0OLqv-JBFQTB-KU82T1Vp8hM9R18i2JLoRLQd6NSOWlDoVo1NneJZnei82pQIKrTxpxAuDZcmOcqfcwhuSfPnVxJDnFSH5KBm0B9is_Rblv2zfkhgmEYRM4hCrc9xAmRbfvd4F7g2wubtXoZXc9xYmrbT23558QL2T5FqUN9WOcFCWPWG5ZNDIajHk6wnufP-T5KR0_GfHkr4TcvKc1FIqlbokl-Jz5NNjB9PpfalAC5AzWMIloa1zxMU0my2QExdgg42U_YdAYancUMcJG610ZOLUYui4HAlfIr_dVu-NBvtiNRinEOpoyWxnTmkg3fl_sOpGxqy8Pe_uM27DMMPd-g8OYjRyiFVjtv4MQzB6hem2pZqWWOeWapbGEOJuNlOkDKFfXlBGCCqrcYU-Ky-eJdw_2481ytMsf4kTQg3eINTQIgXVY-87A5U3P6uzbiMV5XNx4CtTJel9vTFWXqdPZScqUEKbKXdns07bc-kaOliX8lV-Z7sdrzqmiyYv4qK5Q8MDRRAHBSP7A2V7qDcogJI3jYsA1xXELtEzarOXNTFyBecUN_bUjA-TcpRmhOknBFah0DMsNwsTK8ug_6nHVTXBjffIQDNu-VAIRM-Ls8QDwHeRofupKF1pJUm_O5Q31ya8Zly38RDs9nHlIOhJl_zUcrOodV6OkQOWUlyYOVheOWKLqoSrjSic53VTacjJWSyPnjGi_-7WHE7DxVTzZ-GupnyAzCNwdmIT1j0YF1mU0fLcVxRQOQLtLE0GgmuoElrYOXa9vATTlKWTdIkU34DhobFtajcNgxZ68z6joFzfdTS0Mgc_FCzI-F-ZzV7FM4v4X0rJEIOCE-SZLPWwfSottheoYmmvNsqaMu75DAeQ8Kns55CTk8QrcW2bDOJ9DtELty0AJsRERbDjIypJGuIDBJXM80UFHdf0uidvHqln1NgbqaUlyn97h1QXeZTqYv1XUg36vq0ahNrsf3xQ6BCDmRc6oMzrPwk31aZXUuK-ySrYr92_NEerxrgQ5ZIEWO8v3aQSCrH9llWbkFBJZPkU7uZhzYiQbWTdKiqVghP4IcZl8WAyd5Bt_fJKSKyNSTjnkPuZLUASVuWUHAw8j5uQs3b6uJH6djYETWbIuWbY2s15aS26W17UIm9sbPhIaSqAY6f6bwblKlE7hoXCm8yShUxml-erk0A1CE0YhDVwCBHuGuL6Avtug2PxGsncSSdIKeL7asT8VbViqDs9kIDDyw4UNIlBrCOiDyzAdXRCDEvn5i4IyfdLY0BhK1qoS01nSrb3UC3cAV6Pvu1IhFwfux4NljAowB7LB_BPTqoyVIKub2Vk-oyx2J9kTsM5jyATgSh2QA6eObpJj8vL0wTRjFAClZvOjgrAyjluiji9pXLkAK2cZuzxEJU4eZP-fcwG90iqZt0VFalLQs6c7AefwQwHioWvMXaghi_5TGrZmDj6U_YowkTQ8xvchq1EJPUHpnrlsQY8dAvWFByzItTZ4hCE6TK_qJlzT5PuRQoTjJaL7xRjWIA85ak5ixwBgvw8g8wpfpXpP46L70SsF4j4xGzdMoxJN72hkW-j1QMK4O98DQnaGETfQlwod6J3LiIzkMsFa1dPojs7CvUQqFBBAJJ4s61idSSHKudh9fwKF5WL11INUmVtKbQSfQEYBVsIeXk4v30KeDN6nZQbQeG5ovqrpRqaPPbgi29ptsS2VC3Al--kRzvyM8tEVmSbUfpHCDs2kJEMrD0LmcR6qwLxa8avt9YhdcnslRoZfuywL5nAeVD0p5hxBjxuBo4z5EfnUxg1wOcBZhgtLiFZAtm5HWgKsG4ohbP4HmVhYj96vuryPE7QC78zh9HVW5H49MGy6XsGzkhpLc_qe02f7QB1gFssjj9_aD66ya13cRtN1xAkD5LrVetT0PgAYrYJShiideUVrQL3C1sKHenA-2xnR-pCtWqu1ZybVZK3RM-mXYnDi6ZSeEYi3wnSvVUmhl5bEDenud1dP8z2NJtAnTnqVh8wx8dRpp3JKHmPwTyQUDCFCkxHIuDIwGkoqaDkEYpuymwLTQNCZ4mn0pMzXFZclPibOC8N9HoYPRbjY_k27-UWVpjgffTauZAEVcbpD7bcm1FBWUeSHZpgAp5K2DyLmpG1iFJLMwVcUb70OhT-8P1ZP4jXz45lbfaEYeNKHUn6bP8LExLooCd0ee-Iu-_CLYmZfDRQJqKG_md6dtfgdHkFUMb4xIhJwHc-rlKSWMJ3MlJ4mx_INOCNdLYDDY2RnHDvqIpft_JIDSSOGlbx7RrThrIKz8HGcEqsAXPd4qEaCN8ktbIdquW2D3lvjl8m40L87JOyNlpKmBAp4JyXe8em5XANjEMVEkk4jBdR_CFoIsfy5GfVmKyCkkqFhFa9NDBV4dFGynz4zeFVVEDgYcPE_lDAyg9ONSb1HsOpzT5O4uHcPIqe33c9tG0xdOlqmwC2k1eB1B52cajavu4w8y8tnhD2zE9NxELlaL6xd7KvRQpE2sEle1EKsiSo6fXE-WUnubI6tImMQw9IWBqfpx6Um4nCISsLQaDiy9fA8rqrMv35TJimndJa30oi3NPTqjS8xxXTuQQtszpjH-2S0_DSsWAhPI0XBQ_5osP4KCQ0DtMNpjapWFZMq8Yj7ak-Xxp8Oua7CPYMiK-0uZXaKG4M2JeveukD21YeXSIQ-OZQW6cAHeRfDMd3aXYBcPC6QFpL5gfnLwuesdxqweXrq4AQLMidCdRU10VXh6-32KEfriQPoB8W3yZURC5PvT4a2Esmp1am8NmjVJPweRqLeByzpj77B-dKpK4LQZ98yP77OcZ8SVE65aUirFqSEViA9aTr4k1_fNXsVpj3xKtDT4kasp80f_ojYugpL8hGCF9d7sAPc_ZGVnJNaF7lqb8lhdJGfIc4oHxPDi8P9WKiU3Ks0Mz4CZQ9WxLL4YzzqJQviidX0jRl_FTENYZErc4aR5Wz8BcBUW4ZpxINPcRGwwnXirot3tS0eJd0qZm6i5-KRgKtWr-4bvvSXhYUnQFCtK0986E9P_LblPtFDyudrnCi7vUcsR4LuOAe93Tp-XjtHDIVCVJyIs2vwJrXcUJNd2Uy-LGyIQJGf2MvZMgVUKQraaRO0gN7mphYYNl2_pn20UnCX4d74W7oD9io6N3EqjgV_L3bdZHYjBFGY15SGn6dfw5OSu3KUSCBhVpwyNh2SOTGaaUv9zAfaX5Zhu_X-0w07ii07GT83XghOCK-5hylZEXcMPYVhn4grc0yUlfK4pJtLHnPPYasOEj45Za2NpRoGzqc84xHXcsnA3f9rc7xav4yUQxqiz5s2eyc-C_SwT1M6pa8LeDDIyrGGT31vdGUdgszFim5HabAIcJ1M7_gYiE8M-tOdUvseircZkRg249hs-DUV_sEs3tk-OzNNJ1aVKFDzGMsFK-woyN1kb-1gins_W0spiVcqWMng8vXNF_m-_kvVKyOw1BqNByLCrJsvSwBBgdkYVTki3yM2qgH3-eM-x8pOmoLaF0Ncsz5Yrk5qTSZGMDx0QKMzzfuQSKL5CUI9rkEjKFMtwi1bzKwXdMz822nS3GnjCHbFmIP-3JoLjROitmivEbehjc1AkO3TE-nSRVi2JwQWrs2X06u7sP_CMADh_FGC81X-ZkFQ2vXPnPrZOvmUssZVF5R8uONbpr5aIfW_tPvQrLul96LvwW5OBgh-Wf2c5Ayv43N2O0Z4sZqQlmLT7ZpNxd3XUYTIlfgPiH5TAN2Nm_aiNZgREJ6SIcbgZWMq8t3NgHrBu6hmxVev33GDVCBPYHpbujaYOx3U-p3Gl1iprsCjRAdCq0jujDK0BkUSlbWaFHEbJbBwjbNpndKPyV4NbIXH05vggPx8aJkFTOhFrnYTzO2mUDiIznMP4B26UZKAuXBalCPtuIWhIyh8eBAMFP85W9pYUXEkL_unDkfZig6vtbHHPeLqrdaCzY4aMBPizR1zmHD4h4gEI83pli3dC__te3Ie_RrBCRXv5iCP0xYbwZXbfgAoAQrQqAJaF-UM6gcraWGLPsryHRhvlU0jeoLCTjO5UeljY82DEmYqdaWo5AM_R_TopnpyCgGEVNu02cQWk9DGrmrt5acLEK340g:6Nk7y9VN5jkFYI_egHG1Sg"}', '{"$enc": "enc:v2:k1:WaPyARR9ULqcnU1W:P8Wy1V8PMXQSjtyyjQqUFpmvjnsu-teX6klcF524wQuNLkYwFz_EBwki3aNpo04NZMnolLEQt31PYK2ckwC89abep1O4nGT_aokkYyc17ABKCvqVur8Z18fewmXDNqGktlgbGdKlPVuxYRLaPcXewk_PfV3kVyJiVmfM2FANFPcS2Dk7zLu2E-zc02ZKXW3_7Uq-5SqajmlpBEQZcnSO-liD27J6kCt6eeKwreooeyFnKK82ZhH5-tBskv_BTaR083PxxAv2yfVqUokTcp_j5qFm9B0ALyR4eq6-nMgadHFXnSJqltZhz85e8evfIIG8vZJQhNGPEKqxP5ZoeFFHxtFGuXf4mUVMJRG0xmDtmnzAW6Xx1BoYvbJ4xyGXVQ9Mq-ls1fiyEkfyVI04XI4OKoZSMEjnr8bsOxz5s_Ql0npWX1JWdVHy1tfNC6ErVN-xLXRFxFFUNPr3e7USXz-9wdbf8GFuuyvLAcNQnP_L1stE5JI9fCzAZk4pf6rE93ket56PkLH86Zyjo3Z5-EbDLURvWogj8UAOG27tpZkOlT0AF96FptQo8NAFqpgANPBZRKkw9Ykm5GR4EyhveKb3-aOb8NMPDrpzWMfnv6AnhadQUPYNjJn7SuTbA30oJsDgeahWRYOvkqDpjhYJ6WdEDyikAloQQByQoe0HdMnXOhqQZopi3qyMPdWQ8wkgCBVhg6AwA8vXEqT21_Yxq6bU3MgZY3JPetKY6XGvwHUvIn83m0fPCooCi6kSS45s-rPTiBNXDXvpi4_GWTT2jumaZaTZbqJxZm59VqJIa6ZfCbsIcJ0zZDGC79naJd3sr4CK8Do0sQqGJyo80RqLp_R10ToLFmSwdvxagSzBWeNv1bf6yOnvbkSHGiVwxlmzrLtl3aYeUcH82gs2lfDZ-aPwCf5h7CyXkVD05F2vWaowmVkIzAgRdCnFvLkEuE22YJjOBPbozCCIq3tEh5Y8EFNrkPCUb-qXuEiiN7c7b7kA7rFUWIoVnRQQxpQY1MbO8PUtt8pi8p5FMTnt98c_h8WuFCCmwnDH6Xl1aU0TrdVE0a9Y3DMkF42j-tXN9MXAd5qJCsOJPtE9qOUbY3c_VmGX4RlOIVd5VIg_B1OsQ0Uz3-UFh_X08LwcAYLzmAGzgNAZj6uLbPiztiJJec6k29YlNwv3MDBZGCFFL1vtTPnxVuMvZktvuy4ej9ijQDrYky5EcqM3hUOYFd4UvKgD77GCB2CloBEWMvfW-oYpnzxtLFjzGI9BVD4-ofIVaVko6FotInQemcG6N1hfwwU2Nc5GM7GTv4p4B7YyUAtjAuXn323dbmC6BgMYGCq428TCbdjbz5hUiSIo7BqI1OipEfQ2bK2dLcUE0jheBnISelZLh0GSbKIhDYoltbnhZrTnNzK9FTcWGkvmJOEJMO6pWDqHuGl3s299qTZGfRORdcffq1_nYCba8WVkmlEkOofiuDZC95Xeygq8ZOuJy9X1HHhSoOVrcA4wRUtIcNfXi5DFw1hCV_OJH6qLxk101q6AlF3eKdIthwHa-El9dQ9IFgM6l9Azu-Uk2I9t-N6gLeQbxmYGnmVhWJuIMqwgKsdn5-qsAalhV7W2vt1MWhVIrUKst6DjKDLbo1xm2MIsGe26EgPkcvmdHdkZBAgRNALI0rLBWW1UwV5KFCVv-UsbveIte8L6vOFE2yNJM00TDj8rKSHaXx0258OyyeXK6cV_5w8EO5JCiFTfLymHuqBtGUpgsKSdL63mLoyv1dUS8p_xChVrQG9F8GLnktCxGQrUvAVB1TcyAn05INkA_6faDWmy1bZtTkVessN-eTsW6B3Xg44yzcUm4lCq6q686PF4Wn4F1f6sQyVDy-U2c6AFQ6mjTk6iQwund_Ng6zKTR689_ZbGNkzFlQGMTHSy9TvXt0SJd6Mo8xl5EPKAz9bF7rhT4NaktQyjDTVMItvQvDZCz0QyZTRqfbz_fExh_68QnfkYLz9rLJqU2yG_OgBLDELNazDR52pUGxcHxSKf0IM8mlT6fPlUeljaDuKDsXpTQASjXlUJv-Hqw-lOBM_aV24aMwQbENhLnxhHFhGPy8__NGxCRgNuz398ypKUbE8lTXXfwE8qCU56q96vQntAOz2uKO6UUtL0qsgXHZnouJpU3MFunHwiNUcTY8PeEo4I0ES3qYV9gJabN0F2K2qqv_wu68Vj41WQPrUgOt6d9z5CKXoqyHhVGuZNyd7Lz-f9bpl0YghTv5Hw9VgIiYzHMoEb7cIr9wlxUzIlxejohfo2u2n7hw4vtqGgoDW3T5c_LWHAlx3vv5t-oMah6hs8SXGoB5YJjfqd4xWZ5N7BddiacpyX7qsTw_LVDwm_HJdMml9lX1GG2-u6K3PBgAtPye8CHELLVwi7M9rL3Rb6twzwdhWDkOLYbenZ0njte8GNdI5ofqea4H8Hzp7XOkvcu7c2DVdSz9THoBP_j8NAkS3_fL04kk23bjsXpjBNOFTyMRodApkcPAqqZ9ese2nLVhFeVAsGTXgzYlHkPOz6jEF87sZjSfsNhUoP8m9t6HZCLlRQr6Z2uP3P6wWkjDlDw5cVKazQX2XQXADj6SP0zHB0zjtOR7HCMw0mUe5VjiJ5j1U_MjAbyBzOmBUBDAnOMOGlUFGp4o-vW_10R1-9h6h-eBQ51G1hT6741ulk_l2meWG1My-94uPQCcb0GYf81K0DMha6iTQmnsEhtkXnmfiKFPSz8-NpND8wU5QCz1yvLF4NuhNYApO6Le4QtxguFWqyVi9Tfi2qIwgcVb7fezOBEKMXJwXKuXLbSfRq5VI76zeP6FAZHjtcKKxsqW9A7MRlOMDVlLuuHkZzfp4x15G_fVZ1J8WbZNobyR98RlbmumoeQ8v_b5Mw5THP1oAitKEKxKw5nGWX1gIcoLhbaOpawlSvRDei88OHSMuAqadhCYoJ1bAX69j-MDtmFWAvdLl0-mOYEptVyVroJP2nExuVQxHlbUpXqsvHfMg5_bUZmlXWlaRtQWzhEeKA6ScEIicJCE6x5CXLU_70QxD1kqMAe4KiFKnhQw6OrTT2O0zaYeGPdwVzdxiBH8Zo_FtFY5qnXslfZgwGcLqRMK37n0bh2zhTLIPxpg3hnZBOrDXN2NKxkdr5umw554RWnfy9nPCdAKDVyaourM5wjBS68ZVsyCeDMs6_emT9MWp-qlhG5M4F0Zl9dXEHg9klVmzQtrExAzGExp2FJHRmwq_3SKOopzAJoIJ8IqY_cmPNF_o0L-QtSLqTyEJ5fonWqEcASUnLvetGbtlL0ygFES6GkRF7w1U8Xjch_1_ybgrh6IdK4aM_P42cO-e_iehExg4HRgw4aIpE9jb7jCThtf7Qr-NmsFkca9ifXVoLtKd-DbZ76lEh9S4iHEGZ4AzdMvGc2qBSmBPzmrklYcJwFk9vhdLD9wDHAWiKJ17qoG59Bgns9pQulW3uZuNfKyVttlicHm6oWyMsksgh8siwCJb9KzP7Uaug1yJwVhZBH8rsrZGETY256xGLiOpXUbgr6UA-38ulsXyG-yy5K-undIEUdHbAw3bIkvlzf0-ERlJaMGTibV5V4I4Rn3x2aYmHJeX8LpHJPKN33d162IkPPYsZAkBaW-BERiv5VyjaiRdOZgGjnp90ezCC0-CH3R4a_vRDYDhbRusQb0A3lvTbuZUsfLeo1FjYE-fRkG-sDsGkHQmskwGQFDHJhgXULXdcMYEwF-mXCLYs4U2pA5zpMerIt9xdbmKnnfNLaANuHEleBh-1BHWM6nJ3G6rCSU0zjiI2cu8-TR4QcV4e2He0aimoO5THLox-rW0EmACz-I1OIrpgPDiq3WRU-jADvbh6R8Q41GXjdCOgUAB5gallWPuUCaGPoa1lCGHnMEDgAIKDPTHwhk13g4q_Iy9dHzyaHVcDP6pXxAjl_xTBpnihweTYjg2Cb83DQ_dWLq9DyC0CkRXBbVO1LBJnDTpxZjO5pDMpMLXa0FOYOLEmI04BetEamlpV-UB3Dad8uoE9EsSsoi5tTQEzoAKFRzTPO5YBA9A9fibZBBzQ1Pg_C-NOHr6Jz0ySuSn4KG8aSSv3Krx1xO2_QJoZRWUcRLwK4y1M4y5c_hORHwvOrLyiTDT803rO1CcMnLi5gyXxj64GD1Wf4zpJ4mjcjf3gQe7EYKCMMk6AbMeXnMyFMMRFXxurPWTf52U8F2TgabIsBC21CdRk9s0rBs7i5ifu-PDq3eviEOniRTD3HGc93xYjw4ZZDQkbo7j-ZmizAxLl6NAsBdyu2RKiQHPXU4Q20U47OJtbLG-QwA64v6VxYamRM2DOWxlxqhLhahtru97x0STaJcOBSVP7SDYo7mno2_k5kK17ybQjWGfB6DYTL49w0TNJ8L0EZCH4TAf46VJa5DFps_66wPWFzr4h0SiIKkWdZ7VxmDLbDFCYendT8nySfLVeQaN0Og_fdJxvzbcO3iUZe0xO7WUaVN2oDL_l2Izo12cU9cKaSjggu7_8MqdnT4NxHnXQfAkwoIAyuucsxHLd5HofPP7nLjBtPELqt47pYMCPU6PWCcMF_VZCS4COX3K86fU19lQE5G1RpRExSQ71EksArbNafgx3wdAzwrLdjPZgxp1D_ZMOJCin-sB_Eq0YbJerHy40o6nPaukLhlz4nCLFLEvaBrHg8nVtshcqHAZCkHNDyA1Ggx-0yhAdC0bpm2WbdMz9fQxq6t-T8o3CkeCwkJSAuT73lLY-cSZ7PsRD0XZuOG8tH7l2bMwlgugtAxOG_GzCXr35LbNrDLfC1PVKbgfdhyuzJIeFM3IWZYVQzETu6HPfa-FLv2fSA07uUVyfUw8LY8PiGbcWUUc63yv4Pj03PX1rRXsTyD3biVFdlgO4iTVCWE09NWrtpz4ikVEK7WLRjgm0x-1Rr7Hx2coX-JtTMC2oG9gOVoe8kNLy5bC3lVRQ_Sj4iGzYUba8l0mE2smeenkGKzz49ulbt0vr_YCXlJiqpA2n3pulScPb4z9OQE3V-cgPqG8Lq4WNPnV5es4aL-h8q3gUsN_Rvso5BZV9a1o6EtWOPnLnnBUokzgyAaJ4utAwxj7cUq1sYPq7BUz4dVgzrBQXisULAyhViR9cjztASnHXEbWgmEabaW6XYMAawfxzOedKis4lxPkIE9epSJAp-tL_RmM5eAtsPNSnYIHlkVoJ6yMAtjQUIr_IcXuvk605Qih6DBqXnPYFeATWpkx1SEEBA2i_-iqMrXtW_gmB5loP43EUyN1FPUtt5Jht5ppbs57dNWBaJsgjrOJkefVOKdka6a1i6-Z6YT8Lz0_JU6lSSN_JjYSNKZM-XkxHqXjjGPe2Vij5xzmqIemi_8o_x69EgCWwExNgSCmfXJHD8NwJwYPduvJEyhfAMRraG1AzNRsSXBIcvM9TiZou6Wffw9g8fkhYmshCRs6fd_7uFBd1vJXS6k2rEvooXl4DVbNkIboLps0DsPYsEWSWEebzCAf0VXPYbw0q-afZCqzPqTPddIBtomelt8saBjtfBzUS7o0ye4MFzTqKQ5iVRiLYa9wgH31WHgl7nYdQPqLK5Mhjx27YZlTkbRgWbJ8p65CHXIOaKvoGX0j4VYtcsbfsCcZwP48NG3ZOLi_TisIuNfhKWCYW6ETXWJgrzyMhg22LC33idqHWTgu-s_8rGw:hHyQfH0D3PWYcJRR9VXghA"}', 'first', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', NULL, '2026-10-25 17:34:15.874+00');
INSERT INTO public.snapshots VALUES ('f549c314-49d9-4638-ab71-b2a764918c5e', 2, 'sha256:3c6a6f1eca3211b250533ab4c1ad4ec9b792a81885a8336d2c136fd1844e0ca6', '{"$enc": "enc:v2:k1:mQ_vpFHu4X90vI8f:jdet7pFW7NlbvJvtLm1rlYMdG-hfKT_a-pbdzp62Jt7ib35GwWGe6XRT-e73IeEMp-eI_6jatx4bMOTn9g91WdtmT4otGVwFp1LrMUOsuK_5HsfmowFP82Hrpx48xfdRE4pqSoKt1V3sgFE04tvXLppwmvFc5k6fE4r1KfqsKPJGkNCY94sxZbqlEGU2qtCyixVOidU_E_RpIQ1O2C6dQqmriUBBNyI8LQQyFM1oyG4LdqUnctxMRY_lXuKISW2JCK8YqW5wqEYvisaS7w3UuLtqRaktgHUabRrWsi4YTwMkFjGQDFKLRh6QnTXyhP3NGBNJNUWz8ZQ7WNZSd3tZztTVD-94JS-Hu_HJypQZe6Qd01jyrGU1-nJDonfM-u8YSTG8eyLshyLtYpE_Q1vGZtqvKvdEywHqaW3P25XLzE8Gqc_sqYrxG9Yo7_7ZLRq6wXtvtM2rL790WxNJ5tygNWDbXPGu16PVr_EcJ41hJAv7GQRwIBKUsdSM3OA2ZR5piwRiOp_OZL0mAaaRo3Bfin68rtauD4-d54Lh6Ol2Hl6431EpC__JWRtM9oc5ghOnxJyvPCtismGMJhNLER36_Pm-Qzk6L77CuenM-xSY83DSBSg8fHNxs691JA4Z1Y7Ou0PrUYtyhGYRzheOz5FxcDdOddY45pdyaEcdJCcSHZMoDvDp8oxKnZ4_IVla_O6kv67ZGCHWlglaKP9R4EqB-bNW4JB9Vczq1VSFvzLRFiKzaq0MRd3HooOb6rrvo1XRX43WzcENKHvfoo2K73zPijgD1p6i_pAXA5A2YDv-7qCXqQLdpc7YPD1jNnDA7kSjOTPcz7HmgRpjx9RbvMDeg_NiVMzfxQuzCUVTHzS-TOnrdAc5qoy2gIYftGOtdQvtOw1bGiIDzwFn_5JUGyC9VEyJ7_IwRYbM0nxpqekWFTf4jtnE8eR9Xm4zvJy-KYI3SkRjdgJZrQNogvlndZ4olNvRKwsLlucLctJvGMgpEtMWwcHEjj-BkMNaii3fy5O6lXqTPV_nM1H1uKuH8dHsTPaUhJu49cwbD16ih8mFiXqyIiHlwmjQ326v9-K-objTvQD1Jjd7UYHqLXsRT3U160fZO8Ff68GrpqXVruUp8S7ClfvvJCGprvPHeyKkqyEhD8SeRhm0Df2YJr-GzTkIC4sWTnae_vpbK_UqfT86sE7WYwL6UNqLEmJ9LK9YUc6AfG3Ltk0047bmYEan5iudx0aRqNh03CnQiDvSdAKqY8g_12-KXTUgd4b5_JQ7bAAR1YnuiOeC3JdaDbgwfS3yuvYi998s7t3yan1xrshaSacyy6w03cty8-t2JfjeseX-4o7Pmdga-98WJu_InuEbKTPcXRRBdCDi3QOTGXgKc-94ek6wgRM7iJmdXz2Fdg-q9IAxqldHBULCvXFXcQHMMiP6hg27-1RYFAiFC9miQpkzNE1KBhwv_ByE1X5BnHnsXCEinT9wOrmNHnBvNceIoDMdxK9vQYeRPRMLwYlubKM2GaWiMN0SzI-isx7Zs76jxfjo-acHC4xNmW__kAwYEtfxyS87xOV6SfV3I3AhHwNTpH0k2F-tWUg9vpDAKCjAD48lrx2d5mFFr2ov-EtsvDNrV0NNyCKa8CCbvCvILtQl-g4FTcuX0C9UcLl_8OVwveh5_YcG_dOvTc5TypNsbWpV4-8kme7fx3Gj39dywXyR1eme2BZQeK2xjPdkBZ4KJOZi5Q36pYiY1TounT7oTIYULsnA_XPTxT46hjOBvVL8O3HT-_8hNIJuBEFrYDRi12vS7XqeZZnXWWxEf1q7q0Isu-Io4ljIb5Zsrxc6LlhGV04LUCzOd6hlPnOPnITFeFTjaiq8u5HgfSxz48yc0-uUszoKdpucXxYd4y0UvKY9XK70NDroA4qQy7YNZqdMN9EHtIBxP8CIaLynW1mtnlgN2NpkK8jJYT4s33yCwdzFQM9y9SY9f96Ydt5TWAHIlZtCCrBHwfGG8E7jUccYle0JCfoChHv5w6m6-iMWyhAFaJGe_Fw8d4som_OWjbtNS3cKSV_hta-rkKlfPD-k_VNBrfGCChrWoh611OVHEFz1Emcn4gPP7dft6P1n2QIC4mVNKtYzD8HoGI5WVO9c1Kc6lNZsvJFE_PqyNhrKGu1uM-sO3BdL4m1u4xaA_3epDLvmS_g4ckPKCGbBJ8-m8X5wjKPflZN8o-qYliEvJDnyfWfpy2_qXYQ5qMqb0GZSM1I6zmcM4Wn9f9cdFlbt4_kCuN5nXrXo0y5YCw3cHxNnbKd-mJLhxV1ylWdzEFn-et3tgJ2bvLKW6SVAR7KPrhHWhau1HFfnP6cHxZUBXh9ocesXMXbEGD-S1MqFr2tXUnOslQ_0mn2B0OOgOVbGnaLw7qvJ6jdtq9ja3BZcyIX8tJdfbAVhykFTexxWFzLwzHXUVsipvcX7Pbm-QjuqQJS-xPtrSeD_6leEPaA5L7MHlyGdH2h5lYiAw8kcqdka97xi8W7t2L69mgj2WdgJSQG9fR40o8kEKOdh9-Cbjv3EZlVf-utTD2KMMJfL0DG8jFQAQ9-UEzbbPdLOupVuasU8gPTZMlAJXtYS8Fwxh19rTvPiio8K_I79rkK1jBjx44n7_YF7Xwvttgpa9O6cuYf3ReGLIfI8SSTlXjpBioTWaEQWM1H9FsEZZAOISyG8vPJszPCOImLNa54qMqrGeNTF97Pp1A68BcdGX-iGAE-tn86LuSyTx5xi_XT4tv0ThvucrQyuNOhq9BjE960WbOqORJuay6b_3rFu6Yq-TZ8JGzqPzlq0Z2KJ7LFSyDA6kj8hB8ipGJemehfsUzP7pHIYddgkCwE6_ahRU9FqX2LXBD5zMj3l98b7n7GoVwPn9W9BTlXgJXRIyfBFqLrwRyw2nb21xEo9ZcwGmUAjghc79lwPhQimeJI5AlTirzlojIxTwb7vsBw_xxkCaZQ7yWLqviPHNKRxEVd_ACBSxyWNSHfqYJpagHtBHL4qgV-H4rgRBluGf9ds3gYcAYFzh48fuvz7ulV5FxGZhnJGea-xfMcxhrr6M4jIJDOGKjiFIbOOUzDdJ8YACHtkwJJte6kKwlx3IE2ZpiOGxKJd_QlwHVPIYW3SwGib3V2L2VpWsFUhCMe1BySps6jR881IJQapC0HQyyE4SB-qIroxdsgQ2blCWKrPx8rcZWcEOTotPuOJs4wYg3qwH-V1JNyKqM_rCZmGcwcSG-gBPIxVNnxVhXnHTa2YgooMpaBk4YQA3YtRf29UmChu3jY0xich-gfC6LOWIWhMTEP3DdMSN4ztcO88N4FkJzcTfAhWojiuLAFj2WZ5U6hDFP5XZe9IoUJmfFTTmFORq2D2nIRb_wlQx1aIROxReh9t1T40R34RmMol9c9wX2cyyzhT_LrEeBP7iaZ9oJ7-o6QjTT1_LQ7f104jIfEu4DA2-iLVo7XTLl9F971hW87Ny3pbXaQL94itm2ecrus-aF4JqgwceRAkdQV3aqJYkiLsmvWrDe3KCH6fd22N8bWspA8m42cvRGliv-LTSmwkMmF8yOdoEsdSuYE5hqUiHNuMd6wTCccdDXmXFobTsZ91WYPiwynPaoQN9pvlUn98KyA9cP9Ev5XJDwhkK9UrXzSQGrQSo4813a8Bv6wlkA_cXcyJXMeGSw0anQh0QULch0Zsi6F5PBDXB0AcT2b5Nszegi8X41s2tcOLruUgm3ZiLlhe4WullJ-Eq50s62Js54OH5CwpOU76EVm1gspurTMMGc1UITI9rxfw6ii4NnGHT-cMf0Eati9v4eqdTbbmQDsuz79H3iUx2B6kcfsCRlmbsUKXXYpIhHZ6-hMgIIVAqvyIqsPl9tcYmF_OdzTUfBuk7e1gDBKeM_HIsUIGgd-PZGJw9GIhSlT2J_Dkx8nzwOD-0v598ZzFiN_c_aP1Hz62rHXrGzgnV0fNQoT-UhZ7ZkgFu9ABCWE2g5GtfqxgwOK5vvaI3qaqMOGxkzuVbc6eNhTStJFm6VSY9F4gSQkPgaSstbkM-LPeO5Jv-G4zlGSdQNjj8tLAgxbW5Xaq6IqT1X-gfCNwIkhV-cnTzk0m7KzBCMdzFEmQRqUg8dBe3SHW1leTSiypldSRjgBEboUUmLHUk9pHAf3Ua1P5xQFUWsyUDozcbtfR2dRSUl8MGnSCp0v_4SEramYy04wqbm5h2UQlsQMdyqApvKss94BiRj4URqLsuLLc1lC0hwLdkmb-WvM0CoteMJBcnznNSvbCnTOrNbmfr4fqa5Lwzbykph8j_eOQuq6TrBDs3DqXS5Cg8aWCjJMLUY6NXZ15_J2Wrn9LwOT-08THf5cehc24J74F_L5I9ShcYqnvqdYhiHu2g2CX4AGFnY07SDsh4Df0qr9Cum4IjGr95M92S09XQPKSNO7IYEFh4zwj6JDEOVftc7iMKzz301xd4yuKDxDk4iW8b51SYAuUvjUbPsI5koSmNAHAwCg6EXSqErdpEp9497kxE1PbZoRa0rOynK6zAhHFNxfb0zbf7_TMU16o9vLHVCG9_-6_afsl-92lr5Pbh8b0MllzlrZoW5oiLfZeQrawDH5bwOFVziyiCAplY-jq1t2x9sixS5Uv0kq6ULt-8KevJeReIkxcq7l5FgZyDbSW1h56PGtlko75UeHbrSLAVHlzJA4GZvTWiogcCmvEeg7JI0-MdxoLskflD7tgu6J1DULmfaW7Ic9AvogIhgcgVADhlQ5W_fcGvMm5fHuZES3F_F45aF_rIH0mm7Zvl1u1Vah5zCLJWqbFYTBDcpSbX1jG2lKn4f74_XK7KhMWwKAI1QBvSarqbXRiNH5Pfh0nBG-LUDW4SD9GmgdRhpHNmOMq5FRDPjaSqnncXBZUjxyRLp6MSs-IuTPh06zWufHppghY9OqBwDc_QXwk8yVP1RogKcvYpNhuINO2A709ICC7hShPFQhMhiozgzS7-hk0BaTYdPFMTRJBSVXM66SyenE3bph-f7vXrRtB3n3Y2t8McjCKyotqQSUFC08TdMQhbhRo8aMJky1oOq2J_Ttsbb4oWXSWBQBgpPBIV-tqHrOddgfdxnfEnM_lzzHjYdoEVo6TeJ6sVkzQHlwvAIwybesnYDCXqLVg8t06M8Nyb0IZ7uaeynP2vUO6V3lYHz0HQg0Kmo-tP5uJ-7YgIBQrVqdl0xvwScqpOSc7Gq29EDyhOBFbQ_JJad03TY6cb8fM1Ju1epGpFlZErsw5cRzId9rFd28MiMz9XJQeEXqVgqsqaFg-rv8-gNNBFdcHg4FR-Hpm_sDQJ1R9_SI0vZmZXVxgTVre41i0sNrH3bdtKId98FfXYEcMNag6q8idzUpONP3WXgHjpe9tUCJAaPKIxKySzSdByKld5cgyXWjBXwxuzzwoTzVtR3FKZY4EJTuQ5Daz1PaVgaj33Bj0dWp4gC2qSH-SINzjGJtRBDmfr-faxKjlGdSjNuXV87_8ReKS8cpb_qeirjRyaNaZZwvmbKAvDj0drY2wHy1w7wDu2W9Si4Ld8KhfW5a0TrdTKzH6JDsGy11potskBDqtqDDpQdcaEXb3fgArdHssusUW97L8dOdIZ0OJ3kjXYOOAMZOxJUG8Nf_sIP56rFXRzKC2G2c8dE0_QwOkTevCRdHIaplvLiVFhr_2RRFE2-wj_PU1OPAR-VFEESoT512QJ4JBWD6BVa6JGNOxQBblcjGf5IjJUCd6R_6vRoUzVqWQ8fXIxXCrl4dM6ZcwCZNzW9mG3BioAh_jHyMdEQ0fWgjYiiYx2gBKzYilizNTLqDRcKvLAjvtF-F60P8mYRBt3wakCj3-6ZMAknk-7-AP9NqagKziQQtRKXu-DSBSesDhlorwg5fJcATXFWkKYrFyw-GiLl2ARTRIiFlGylg69AAr6mgw2hM_ykg8K_Moqd2X4xBDJXhMYAHQzZSDSeVwfz-JCsWTuHMNjNZVf77DOregUjbN8tXtUPAEIXvAfbUiEdr0_4O5jQE6eYEpQYY7I307xHjMzP4BXsJHixHUUxyBqR2BYeytdvJ1R56xmFEvqTNqoo4LXB20J_wYe6Hnan2vA756lTySw5YEV408MJ_8rhNjDuPQ8eygvGRseCAWGKcNcLuFnVt9dSW0J_xqGcAH22sxaBcLhhY0svR5DsveoFRcMt4csiS_Y4ZMzFUbmW5HifMbwhsbsi9LWygVvpm8ctXVRvynCYOJqutSfAiNt_bIws0pDvGuvstgnd5E7ZPtE-GjParZDbnhNVob79NH6VwFcHVSPd_uY1wwqy7kE9_rWtenEgH46VLCxjIBJ0YBFZtNzC0firj9P2lSajGbyyGtUFvncSkK_86a09oZ6r7Yaty5VxwJ3-a14oQT3kyqGqUUVsubWjkY9PFVMqNNh_ROo2JsVuKqy7HE8JNKSS0CO77VxeuLXdZDe5sUnhTjWCIjsRVNdRX01rYFXqkXa0dUWcwSGIkgAatLUWUmqMrU1AivxbE6uZGKwaB3vm-jFFhZO_ykMGZQ5KlC8zpUclUy2uxAEcdd_2pNucSon96-TvbJnklL4kT80L6R_c2UgB5mfIHCMViB5hdiRgxsq5Z40LhPSzV3K2oLX71d:obfmigZesMUwLaBbf7zH1Q"}', '{"$enc": "enc:v2:k1:hs0WOgP6Ih07O136:nWOrgjqoqMdcCtvWgt3ujLDinlLlK007lz0tEWjE-AjphjN-_tcJtX38mp4HNjN0G6d1vG3eXcx-y-Lz8voPUU1tDYiWsvM7X--2eusfFQvq32f-hNyLIAPQ0M0y5UjCiy6yOFbdUpBWFVM2dpB5uSWvgO3UfAKGZTua3bGrYtDaHc3PGhw5x5fA0uCacMoL2tW8VvaT5Vc1TZcH74_PCqkrM7_stou3dQuN5z24YWT-wIpeGx7s24J9DWYFGOBsHaIsc88MOxCpK8r2Nvb4kmP3EGqPXaorRkj-xk-Qq5GM-B0yMIMfczQOTbPSWTLZnu8MRV7NPqIE9zAZl2dwu-yoJmiblUNJ0nJvyb6zvOhrXoM-sHZSlsK_uD6FDW1Rrt6abMGydtMDWBhhpQv8-aVQtNHEfu7FJeOXfdsbBZIcajiaLUOn9owhD4CFZsImVlEFL1D8HIkyR1YZ3RVHOUOfyL1xwbHD0UFrhkKlOw22zsPoHKeDkLLKB1NCIEr78IFn_UHrMBQViyl9oLwudK00f7Lfl1JZ0HMbPVeePypp00n_xNWO0R7CKD6lxgzd_ko3YrqnYxVUa7v_viUC7NRek-AGPTwNMyPGKIK7yFhWIlG-vto3tyitoQAZir1C9RargwoBfvkHmUQvF1cDko4nUQuMxhokTscZveteo-c_Sxtx08hvNO_3eYSJ0268xjyODWNbSfywlOpcZDXp1pH69F_SmWy_qPM-BeVgMEyv2RCIRKm-___u4brBR81ANbNCqorskzbKrhuPvbhJn4rMWrlrd9ljejTolZEC_xUKKjmEurqVhYjUpqnj-Gt2pfg2nDRKplkXQCXTk8PrV3DaK4kMc1YtVjQ2uMqipfEk6faJ42gXuB1lGgziNcTG_0HAuFALaFkSUn03oiXhpozWa5A18ySjUCrVv1q4jljm_PCG1p1y1VzjOjcUhNTbrwivfFSg4zU44stvhCEfOF4pBMgrMn_njn82GPxCo2yIBnGhOlkz5eOhMGBSN3JNRhLNoE8jDNVE8jArd8_07HFQoFE2RokGikctiRUmckVktGfMWzud4Y8TchOMBuKgIHIVR43ABGyA3HE5i9Lfdq_vHV4M7XX9PS4S8Gv3bUp67JDHXk7oYB-CxUY7-ChvbsgvwrSNBOJIu65S8sPW5zBrbepgfkkUCafND7XOGJMiyQmmCxRSrFJkW7hXcQRriLSU012lph7XOhsMd_RgtPExZm4mtAzsD-YDOzwcmJF1T4tgjfkotIxrVFJUiUcYjesjPjo52e9f33cTXl0JfznBERTCTdmeIhZuSSFWQ6G1bUKrOY6-adsuN2TpP2yk4lR8LVfn7JX4F13vEacaLji-YZAlwHkPRSlhy7vz9gcqvOwOgtU9wuaWmpy0IKvdF7SCOZeu0-1KOp_rQHigGb3GNzVsMdVW3BxU7QkVawmCuIW8chRYGzaUwUpTm8VqhH-Jfen5Z4p1lzBkZX8hch8OiBB1q_iI4vfBmELhBwf2PVXrCNZi5JZHZw9YqiK2tPE4b9v7d4oqtv4Ugn2gjlZ0puspDqpY4NCB_O179o4VEVn83LVKzWbcen1xGG8ZhheQx1CVEJ1ZkYWICrI7glEwHAe4NngF5c29HxSC4PDOjnTtrVoNGo-ujk68wo9alBxhtsLkNVZ317z14OmH2EyZz2LATBCebVvAAjmKBR0mTCAVOXgTNPC99LiAwpIl5_LfQDA_7942nZHHf-eKdsoTHaPNiLGYwS33-R7YMxuBrj6VJSITyx3pLC_Gh1oIwsNi1tsSDxKYOhJ3PJs5GuPbqH4ehTt2qbzpj6qUWQsnt6SWC9SyrlnvG_l8XqfYjoaD5WAqIsqYerKaLf1GNtI7ataL-C7xfDjcu8Vchji3oxgfVTqMFhNmAZwI5xurWF6necvY4dgkwqK4Z7auy4jHqL-ffeJ3Di2P9-L-l9BZtjSbsSl-HXEsHPlEFZduO19Vl7UhxR1eEDDpL2GjWBave8dhrPFlVvsOoDYzc3xwcfWp0uEQYdZqAJZwJ9HrO-Lh1WBhtDmcWS6_WRqHmASTImC8bRrxF08qYyk3tFUUuNkd-sx5mg_UpLrohEREu_5kqRjD-Cxf9hu0DtLanNdpxytuAUfXjW7cdScT3VeFAY5F25kVnNqzZHOht_PO6HAh4s_dRCtVerh3JRvng3H2z5SsQ-wfgw7KfQ6Ih5d_fkQfrch5Nni2N5tjkapuX6E5cT9weYYfzxV1e93-XPzNu-Pi6IW8a1lX_6gR_wVdxwyC0h34TnhIIBLCV7a94XMF51rYj8D3dyPmbQKI3qOlZzD_Kl6PtQ7r04_x57b3mljLNLkJNMa0sQrWjrzZS48IHIt0woRHz_ycp6FFv4RgI7UDi_B76UmPS0clFSPjq62Jox-fkpRKfL0JCmiBf7wF1aDBeENgvdXB5BAopnDXuMfYacMYvNBy1dIJWTueMnuEZ6wZT6VFR8hmHuRtrnO3vuHcoA_-tjXVSPd1U0rMs34EdFuoGUKWwx9o4yMJqlh97l0QsYFqYMHjuK0hEdivU35OxIk1pVde8dsC9zebcPlvjKeronPm3nggFEUJoUVX-7hK5aHY2Dg7Kx1irIgsCs88RQnJeS0m153MKDddzd3g6QAbAafEByqRcSveVm_DRJs37dcslOIxaakSSLq-DRpuItUmpWDg1fJd7hMA9SrCtmMGTA_wCZttjVxhU2H7-PBUCjquOg4JZgUUQUoZXLd6EWUjkMG-JTAsNu4Tu9cJKLjxfbNafAr2FzOjrj8ViHymDdL3TeKN8385P4SW7UCnCyLILRw7saa9gHUbBSGJmYhXGn-gO6eJ_UsOZVo0N2oVUTT5Yq7eHgdzKzCkct4HZf2LU3u5l50G4gPxkrUdWwJu0hbEWncmVw4BRSW-bblm_EFVWsOr9RerZ1RYv9eJjhfEV9yFWpjlQ9cS6dh1vTUp9hiV73Nz03Xu1hjyX5zL8jXo72xNwdEBwDdhdYfhqxEQUDkiSIGTN7TB3Ya3AorL-ynMfwpvIJW4O-99DdSZz_PgG3G2BJxR9S6--QGKUEIoslldzLZcZYJ4I3jvx9fgfbfNS794xmLiH7NSYh0z7B44zrtNzLqj4Ta_2yqHr6S7BEwHUzYfIaMBC0F885R_E20WEB_XXpPgNAZ2jXG5CpsTW7fyT-b91Juszz-5RO3TWpuIwCfWgU6tdB_13RWRqCvC6EOz_ARTdyhlVHMGPZjZGRLCtHzwaD_P08grS0cHQJO7TiZQCJyU-_QwuuHYYp1s36GCiBd3EiabP-IE0f2x31B9x3FwOQAkrWk7KOIaU8wijuUss2QFI8jniblWPEliDjIAEEBaY2_BmErlvJnGCTs87gJnbGMRUg2H57O9BalQccyjEOkE46t7_jygSfkFj7nw3UQRkVluNkJSNGUTGpwU53ONIJ-q0Rmj8RVlM-4_lG-j66THYk7do28opPJeRKs--1kSaIcsEHTu6pz9ebAeeNTinsoOgmo4BGvm6yGXu2xfoos0RgMBhdRhSArVnE3dj0sWoueFJXIgkb4KVX_-7mlnS9rq99qjnrUv55t_2155Wnu13UwE5pZRrJa9Nr_-vyCjiIYZqz8Fgt4lHdC1lMPRQnMQaC_YPX7DAsv_UFBJlMsCBsGD9bgJcr6B891D6cTXtA0r0JhfwrD-jw9VULZBznOXDGSlU3zhutG9Th96Er9B179xSX8zNmCXbCkWXsiZWtv0RXw_NPASddxhJ0GYtJi5MU6RTFaxe-pI5JRxxf21zglCbrFaorsvWaFKOU-HE65lpzpIGEKgr4wR2LE3DORBLBLpehHc7m8OLLyOkxyyNrVlhe3sA2ln2S9k-7JpuMCUfQDVViwzYgR4ywzxWXhKtwfzZ9Um3e5VT2O-npjezp6UgDS1BaxTAc7-rBD40ysgAb1dfOgtElt6Zf3YCvdRejAzsMM_DG-CdHyoTz8HAQGKVcZys7aOW5EB9KuS50YJURzc1q37Im1cicOsw7xBqWHTuVYJHcvpRIwNeyCOq-6em3xtW2ySAMI1GmAfAFxYEBSNkFlnpuergwOhSyYVG5E7u4RTmC0t9Vqsfo_crouJDiuIjAcv7pEZ022URMkOml8-OrS_1AaAIhSQgWht-4Jkk4XjtcKbW5b7pTS6GZFEZ_lCNaObKWEhP_Pu7zkqNvINcZLjpeX7qdNtwEY8OUEeKHGSgro6KQ1hsG-fZ3dGA7mkkATkiOuMNVSydrNvIbJUDYX8mOqLx2g1ArMs7j4WEskOTNWofg2QSLPg4M6k0b8mgonv_4huPTj6fOwgZjqoBAQxIa-MfNxr6okelI68tvmP8w5RD6ebyZGUp8a8vRDKSOQuDlqYO33NC72e9DAQTvRxAVLZ1MrOl4dnks7fQK5HYoQuPGP0TBx9zuwyKUWyqYoqDFOWyT7gW8-XeG0V69OPiybMi3NCTr0-NVHMsREVrOQTz6vQVMBdjgHB258LyyHa3lrkVUb9l6Ae_-o5r5J5li3sFmm3RSnYYeRlJhp1m34MOphgLz2H2bhhHt8kvOwJjHTh44XrUaQFJmPVQ7Qxjs-dexNHYENYw2c0jNL0oLulmErz6lHH7T1dvQkLCNsOC-LCeI944_rUg0qMAOBH87MeaFKoVrCf9YilPFm5-FJuS0Tsq4un3RLVJChHSpU5I2dMiSi3x8wIbxkaplO6By-nZMaH1YXuEMAP6wKXrDeqmji1hRo5NMGhKXHuCu7kc47LfXu7PizcfyN-7YwPOm2GS3rEmc6eq314rE8yIrf4Y5NWD37LWzjlPWTKELxiH58BTyglFn8LO06QZUgZit2hKI_9Mo3ZMXtBsVFpyjTXvHTTuAeoGzvEi9uncvou1WvyR_7IvJOD3SxIhyZpwUU1IyXTYzB31rJ48JJLK1YuD99t2uDO-YERUFLoZZAKMdmBCcYDPV3jBfU2be7Uw01Ckercq2aQ-YvcaAqQ0bkc2s7_PpKQVK_m0bnBLY6xGi475BrnWzPnnVAMRFOVJNKzcCStjZxfbJmMa8Eouv4_1e1vU-SNqMsVioPf6VteOJrkrAyMZnFFSqL4BkiLa-MRQM5cY9od2hobw4NBVFtzcwjeHTNFa9xnTz4n8gYONjmpVUZhvHaC5lw0fttHHf4RBIjB1WbhrF5Ord6n-76QAQuPciPAjO8Pjsn5x1nUq5APmULWt46fFtgef6AYe19uTgzwOdKeT46B2rfqoMPsHlIZhHqPiSVIds6lXtrWUd7Qnl1IEUyi0rCnHSenFt7dL4B91Xdy9Ok4hrk6ZzvrXwYm3irCHTQ-ATG2keR-kYFScABwfbgD0gJDDdx0_mISV3Kw0TipMQugRo8yeXppc80HMPAMIHx4MynP2TIAnJwL11YLo2FBv3h7nz0XRquA4qCcv034a9rF2lroX2WjR7ErGDrXN2UIOfJFVXfQa0MKpCg9kuUKUSTj1UxmFB4OHR92XgCQ4V4M0LpgxOiWxfYLzic-D6l2DkSCpJnr7DEhIlEqo52VTFYznykfjo2znoQDbnGEDC1--DCFoCz5ghkcNlaXYeyKoBN1t0zJvr3LilggEMP_kDP68TvM_-WY6FOF8Pw0bUJZlXFp-5YsjNGHLGSEDeUFrwQIhR5Oh0IhAJVyrdSOem4iOafQWxRDQEqcVTmNB213WUvPUpGih00oX2F59RM5SExR9Pfi5cvVG8ROCndk9OIW07sOpNEz-zL20KUmtYncIB8sW-8AY7AcLgFLbl4q3F6aDNIIaoWPfdMnIuCgdBtk92V21uMMYVuVC0U47NKcstIXDky5EaLU4w__MGdb1i9sJH9JSNX5kxV7qw7RDc6QbB1k2mmhmIDV0ftA4q5O7SBEzpRHAgLLxVQidqoYluACQG5VdweyntKkVGf9mcjWci3RmC0Y_-Fn5UaSqxuf8-j2w10gARo9gUNHkAJMOOVHFWWjU-Y:Z1kdGrC3Hyjm0GH7xuGSTg"}', 'second', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', NULL, '2026-10-25 17:34:15.905+00');
INSERT INTO public.snapshots VALUES ('26483d97-1fc7-4e4f-b947-05fdb7258cf8', 1, 'sha256:ac7dff1a71f18f6bec837986db4a945adfb3aa00c33184b2f093d684aafa301e', '{"$enc": "enc:v2:k1:x-mYkdAXdjledzGf:n-qFNGyBbl55iA-ifEE48_l-pxrBwfOiftHienSJBIfn0Z48MUUu3oaRPRST1r32_0QmvQo42vra23LP-8FeTDXSqu5dmzinZBTj_GinxC3pPsa9ECsMRwGD2pz8Ij9jX7MmS3G79xB7U9mdmPLO9SCXop2gMthwmxlk8_I1J0pYUlAFUm_7EcTk1ZrrHxjoPYjjPXAzJLif08lbaJ85mWlF2guYV_Q3p8cWsq74xQibBqC6q_d_vO3u1p1wLQ97lGyC2TQ54T9P63p7K7_OEAbQ_FUS2B6o3myDEky4v4ndcp7Ir7udoM0sxy33p-7lPf-yz1O0_SYNHt3ajGJN7zdUgidlY730akRvNDSYyF1xR6yf3JInLeSGtMEer-VMOM6ZsuzC7zILPSGpagibNuM7_pNn1ZQ9BM27d0CY9nNsWSqr7XU5mtqG9MXLKOIN8wiqsAiadHtD67Ceiq1BJr1uXQWe8Ni3OAeB7enwEukvJ40MyBSdtzkYzgDuHNuZw0lfPLd7ASXyo0wmCEDIRCgDO7egngrUTU2IpagZXmdYL9-YF_BbRSX4Bjwb0WAsDZCmx90VS6TcZjVxuYBKDrD17z2YXgs8CZEPVK4qaGQvFz8XB1XfyxIE1833zdv0g1vCUyWni801tSDOHDrpt_ikfHnpSwNWWt0bspzkp7kQfSlf0sbWoD3zTOGeEyb5Gz81AWry2tIbrTsw76VaTBalTtoJgzaRgXKV7cLX_Ou--aB4FtmAMET2S5Ue3z56rEUK5rk10wp2G1omVQrgvo2lB6tj9aUn31HR79rxyUqsW9F0-98t8FO9mqYUvyYga5kjqTfLkSvfzeHKYUqdFUXrdW4eFWhNOTfOfluYFxNET0HJa5iPwfERmF9d5qvp3qk7gvJJZg5SWt7_ImX5u9Itlrkuc4N5mM7CiPcvVV08tQbgdBhmiS53MXS9YRXZNft1hRftxzJiRDmPwCr7B__lXsf-iLigtDqvIYNZ-qFbhVWvkJjJMAzxz_gE34lXYDh_3eePXScc0FZIF-RG5dbEiL4eF0BoKOaEig-qW_7iNoMz_8wxYEpGKpyeNeGvptpiGjpDXH20EbLS7nrl6auRs04JeA1GYsXcGBvrLDjjVvF5K613LrdL0W2Jkvp-2hZHF7S2-hh-lG3vDh813gz3sj8D28UDJMpMcAWRo1v6p4mNFRZH9hkpelG3NKCQQIV3NWaaJykBD4f0n9jeQ-TaUFyiDyGSFS-QjVqHFTQNyX-ZCY2tqs4Vp05YIzoN1jfub-zWdNYx7dN-ZHTuanCDaHUxetASigYuT70C7X69nP3QcznUxyUzuWgSBxPJKEuyqogvHgwbKbW2k5uIroh8jodved35F4ay2xnl3yTHl2dPBSJRONpC96sWCVHA72hX5iAHXI3DsS5HuxYyXkr96BSCVHxDCjJPcnQaHe3ihtM1lL1lnSFifi5_rOk9CUKm5whVmXaIpGiXp9JJsqm9A3ZdIXYE4JbmB8Xhzv90XxQRDYKFbKSojc7UevMBHe769zSAARYEGyKq4nrClEFNhPRH3wUM1JmBaTv8a4O-BuPRYcb0zAkzGEslE7bLP3VIwQzVMSXRyLX5zutgJKeQg6bddRS_miRlyIgj6dpngFU27Iq_9YsnrGE-nLKgQ4EIkk7oj_VPfYbLI-UL927d9es_GoSzqiBTpsn5gA9hXK47v900VSf_sk2qz5JTiggIDVIB4c13syNvOgJaPOxirj9HuquL-SLK0M57co27n3C1vx562lVs9HTtFTlxqOT7_KOcdzjl7jIQE58myj3CXknVf9QZaErXL9GTy-F1pnM1X05ottFCu17nZCv-RPlmFL-CcGHXqeAh8IU2dacJHEDuLW_-koglEWx99gQ_QK0uov6rBsMNs8L7pvajnU_hEI289CTwgP2WZcKgFwJxkYSVADh0SbS8J3yRALSLYlajDawEtLyPNzodsexp6uy5Ka2q_5ZYNVlxJyC9kgjppS8q6EwQFujkSII0A9v8wiaKjYFLpVBYoFz4HAeGdZ0M7sonV0AGtUk_X3BjoIKk1BP33onVFiG7O5Gp4EvsgtXszojYTxxV3avwtk6nXTFZ351Wi4Tuk4-_bZMxGJO2S7v_gjItSsmraQ9a4QYJGDhnYi5Q13wCxBT6g40gak49HHuggXLR2zTUx_JcxfrygUbbEOkNlUtgvOAUpkk1fAqdB_L8rCkF_gwy3_K1TmSD8R8fAG09dJemh-A7fEwqiQviOfGsyhTVsb7iRF8rCQ5s8WnH0UhSgTKXQ1MQAXZvGFkq5Y5wv93VAAM1FaV2vxrBcmrkhzsBFBhxejUJmNnML5E1JVMlROb_0rwfN4tRXcYe8y6BjxC9iO38SCECmnT7-0NCRfyU5HHvaJzQ5G9gtKDd5iJ3bYdr19fLtjT_4lJKBJhdZMcBbyPNTca0yM-v1WFstXEzwqJ940wBdZzpRjEBU68WyZkuFyx0KSrY3YfyxdMrJHWO7iqakuYuEdCZDxJTDgr9-EPhkaSe7tHOkFkWbP7vdA4Qpc8XpAdW06-Lp0Cg9G465ctzkYFxPVqGDM-dKc3oPmaaIzFppbNiG0jTCFuIn2f5SWm90DZ8gEq7Jv8FDwAxJ8NRBwjt0YHaWpbffNnHxTQy_9Pxq5WJeylC0PpD0ay-6Yd8Xsf0ju9zfPMYMw884Gj3inbyuC4q7MyoGERUEheqcCdkgEIbCe7YFQ9GHIhVccO2FI8XuMh-BybNPiq0nBPGCAiXY6xSY1YQleFOwHizv_c4SDnQnM2CXTrsER7wCUQIHkreKV72Ew5dqIZDI_kR_ylsp0sHFNXwqLjBRmRivaYbulnsN5Pm2B_bRN8Q8ndFKRt-liBQ9JXAEZa3kHT3Y8aNybGPm80TPOZpsGp3MQvK-eGEko1snntqd7vLN214vFyB6XPNXL7AJzMnB-g6fDBR8aAOrcHfToY-2VZFWkgmsURisNHSZ8uV0DItwh9lfzm_Xp-bT9PdboKJdEN6FqkO0hLsKllPSKykpxJufwdvoZAex3SlD1xDfma5mNhsWkxwno0TYZoVtAXd0t3Duuup3JDCd8Cr7oexyjriHlD1aM27YuDzH6gDkekhWHC6SQ3SPlZtEL1wmWMpSYCYiThhXL30H1Io64z7x9Zl8AyfKSVBK3sMtZG2zI0iqUqQVREbx4i01RQ6GtWG1IGSr4w1feE71nL7BnSnHP-rGOS6FLAyPGqSJgI-6A1MeVawpwu-r_24CN5YhEDiPyy_4XvNJNH5AZHy_s6UM5eXnMWK-pjF0E-iZoi6OJ_QJNpI0QZ5W9JyTnlb8CS015ZKhryoehBIP-LZfNB33v3JqA2eCNSEdelNQjk_R5nrEve9MUXrzQK3Y0ewiON3dM1HVGOA2mpjpMbv8P2317GYFBxsas1bvYm2dl5kp0CiyX_TcGdio7bJM1rQd7NeJmKjC5TbxIo_6fWIKBNxs8XYWzGdpYk965QMNNCc9OzwQV64yeyotfZ_WQAGY-RMnnyvGHuMWFL7W92oXS2t17ZYe_qTP7dg3stfIq1Jh1Ut64MO072GNGIp7JTS7Z8_IxezZUzff_4PpviCgoqyJ3zxIoQP0heSj14qiOjYxgMqtPZAH4vB7uzDxVfMGudICY_NUUkHFdAf5j5n6kx8995s5mlgwxwJDt8ZJ3QijdIjP74QqhzZv_YllZbz5JRiXURW-W3s9-s50xR7Q4lP5MpbHxJkkChS_icIYk_OVD0lu2dTL8PKnrOw1wQtFSgpHd2cZRe82spzkstg-Bkm_dDYKE3fg9FrwbMB6wysmdGmFQZHZkfYo9jSBOJ4Ey99MwhOSyv8K8KQHKOTrunrTMtl6QKuMmTY14d8-OMwAXGS0UA9WpyrpggP96Pl7MiPxWDXWpOQdNa2RSXI0Z3redOKSav1w0n8jBP8VbwlTrRFU9Z53eco0VfdqupcOnAqvhz74M-ohq8-x-AJJn3pEJo5tO7JBOO2B_HRYH0S0AMkZDz07HKHn4_MfxT61ZEHq1LDOfRcciCW1m5YvyhSUzl-w7M1PmkkcAVHWP66114PtyUG6c9VsSsLF4zNsKcKEQas2H-EbU0qcN8hZj1AdnpvwmxM5cpbHUDgXKST3EMI-k_dDfhpAJzMjogzpHac1ealk2ZSvJCfOpaIeYJ_dnXFfXhOvpHZ3z-E_FS6rxpuOd0-lC2-rAD4ePSURB_ILl7s0mOzkfeC4wwbbWY3RHKg8Ebau0uUWGZ7dL1l6ErQ8_yLA9iMsOI9BuS8lia25EME1FbWH-BaMOfZe7LgFAFBSESEOYQ1zUuBeFhq_Om8Wua2QvGbTn88C5yOMahb85DLPPHG0RIonJTjghQbKiDOnXo4YOFIHMYiBawPf8MqXBQfl5cGwr2zoJNPGj2pzvk9pOaoK5mcJwO9wfzU37pooqFgYGGsLCYqDk8Bqfiif4x-UcM2hOrqrJFGdDNycTF5olPQBZQH8p3jEtj3AGba0DRs40F5h3s-i8Hr0A88afZtejM4bgwJUTj1l470faVQ9Ulkrvl2lSYr6GxkRyO5DPVCMIHhxTtSI3uvV37YPRbS9boo81WPAqkbSsBCdNCEO4vCEvNztHHFd0ACIXd6ub7DwsR1Bqru1D9h30BqGj18lLQGoASiHswMOYXeDwe7NOSqBk0vaguokLZ02d5VTGDkg7_H180W5I6Jsh1UylFEK-HmtzjK8JPmXHaUZnV9OuKzlWO55C7UN7cjWrtsfLZFpoXYzdRrGnTF61hDvTsvt8g1C_s6XK4hji3x8ati1O105iPZYwehgJBHD2SjiRuNO1LJAjjss9DGkNtKYHMoS4YOYUv0Q0UE7sX7RYoQKPn57mNuGEI4CjEWwuLpAEz8cvqh4_wp3L27N2uYofKL_rrsixNAfuy_TfnC4pu87czJIECfsneyNekDe7fRkASrh-ziVvCxZWQhUjcSjQW2oGXX8Q33yhRnNYDqcPK3YmlBXS4TkWkX5d0yuQufEglqIBMYqvBqEy8kVZO-97CXIFTb51Sq2B3SDYX6wlh-rh3pX3dbXuEiBt8_kPrznvLpBmKbS-K_mT6WyD-PiwLE1anNH0-SDkcLlzSLT6Ne7_AFcy1QefmgvQsSp8AF0EQtuWRyrW23FICJE78YMgd-NbTStmfAgKApgiA6KrjW12eOizbltMZXUFzaDLDsRkppiaeqypz_33R9XJxQ7pyE2jmY216l02IsJ_zyvHVLd4sV5F5CgCmiZ4hIQB7jTkSvMx2aJIVie1IYar4Gd8JqwjDNPB7eNPuiAxrDvCCu7Bae6qqXYbiUIKdObBUEMCgagFyqwdn2w_SMK9XTt8mT8AfuR6WBcT_g3B6VfA4ctlWwm3D7dAMB7BzQncWhYFSIPeX8O-PkF3BW9zT0NdtlogjiZMeGr2_GwjxXUUjiorvFm1jlenK2xx3Rx-iEF1Xj9d4h0odBAiJ9_ziDcX4VtWfmE89UIo8gWi3hK6s7K8xFEIcmHnKKgbmRh-zDRHQrqa172NUObwrBKUGK5ReqyKiJMV6jz0X7LjWmYZ9YtEdDuF31qevuvNWo1s3aKsXcTI8bJJOk_ZGstUaNkCwgSwTQ6HbxUeWnG_yVyLzciMWPAJSbHt40Bx9e3cU8RyxtOtAOPaojjYoQc_-qDUFXPGVdg9uECwLHtsm-__gdV4ZDxyElRuOJaqh89fsnQc4cJATATZwVvwIo_Ma1iXQbHoR5iBQI8uNn3iKECKlP4rfiI-mpkBA-KOS6QGWtYGAb08sOSdpyJzQnirrpbxCtl2bGHhQwaxSK3QrgTwNLsi4LHU-z5y0VOobOkzmgQ6Jxb4ROcKSwM6Mys4kF2sP-5Yacw3r9buiEhqZVrIQaDghR9c4i8Rlx6VgHqkuUZLrSK__0Ytq4oi2fmTUX25wYIyyrRTCuTXfo_xOn6C7kcXPAK3uOqr7vQT63pcjTnC9AlZsT6OUf1ys_qKHVYXJBcAlmGpN9pzFc4eN3KivY8_E-_03O-P2P-dgjzhaPed-G_cWQnRRWVtMnBg2eY4JnACqqUVczo4FGtqURUcI4292zLeM33mih19wq0oqTGEL-1G6oeteP0TSnKJCPFObOt7zF2hONTX1ovE5fCqxi828OBcKTS5E0UUvUFy1YvaFmeUgJ-wI8teo3ykpaUUDU-crQsqBiJwM7AbcmpBr208IKErSxODrt-qJxGAb64Alf218_nAVcaYcXSuFbw6_l7GnRkKtuCcHK5QPYJk1LxAyMs4HCS0a7:uxFWDLM9g58J5q8S9VPs4Q"}', '{"$enc": "enc:v2:k1:iO17nQpLk0wPTed_:dLPeYrb6S_Rg2TNmcBHGQd-tk2mpX92iyVeyaw5aN-RKz_Lyb4Al2v1S_UCwg5_VoVCJlBOfEaXlQV_37S2mwmSS5cgFhyZSkAqh3cyeuUS0sAE70fi2UCNgOfJ1aBc-9ECXOctYSBlNRea2PZol5Wv6dR8AlEgMm3t6jyk4NFRlaZuCxj5NRjKxhYo1kJfwyfWVlKWDMuj0rrd_eCZE5JnQK265a7pna1rGe6gK0GDcOTWH9gU9HCzwGQPcG9x0-v2bDfB5N_sVtb739038dKmSAte8aO2umzYkoMt7NsbZZOhByHHUvo3qqXdQG6Vv9EKKQZ2BPBowliqFhvUXXn2DjD4FcLN5k0JoZcW_9duyNnWwbXagP_oI3j2ei6PKZu5OcHJ6MAuFa4dkX3U0xHK4699blA8a--ZfdNqfcOahcPCabCuXU-pfSYWylNFln5N_n2PfohUipD5sAo2A18bApTwp0flfHsfV9dD0XYaNMn4cdt4HNW8_I9loSPN5sXmtZEL1imhilmwbRwsDdU3DVjoiRQzUIoikF1PlPkRVZ9R_KPe8aVMvEDWcf8NtYdcQimn6fmbMdiQ_wwY6zh0DEh7IZWltOxNdVTopZOuwyWeKMSug9_pnxiD_eDlp8G5KVrB3sUajOJijPeE9Z3EiYkOeV_ON4HApNzS6wRraAZshEHFqa_4SqbUDjY_1_bacIr6yrp2VkyGIKYFh4WJIVGqlOlMhXGzNCvlhYhYON3tFyeOvAXo5JXh2BTCmaXRm9aLzd7mpaoQAMGVsti0TjaCvU-0GcRoJeCXkkXDA7x3QD0d4EcvVuqjuvi_b0W_CI6hoK-ciFYQYvg4GOx0kWD3aXoT4S5HK9WkTE-_psBG42NphgKS4_hPjB7FSoruPqR8KyBTWwVKZTc-p7E58nglDz1tlutCNsxfM4_u5FWdLJQqI6Tnhy_ekESKqfN6nJVstdcJHQm6XdVrGWBt0vnbHjG_xywQ8ucV63Yt5CM9lLkm2dJek2UNLt5fn5imqkGspQs6kzWKE9ElvKpdgPt9qHOMKBmjWavaP2MNQ0rKYwPXFY-bDy_wAX_k_f2xgv44bwLU2VMcDaqRaxldH_CGBdYnSzA5RBV9RoM_SUfoTN_LzaEuAMbzyN7jYmRsP8VJZ1X5EU7R9lqseqo4WTVn4yUywBUN3BVjWyURUythE-0RtIqLHa90M9yQw-6nCFMar2hZphvrnQ264pELGDRLuXW07NMS8aITX607h5ZVi1zwnbZDJJEIi71W50aLOaHIvZsPXlbUHxzwJzJXEWCVcJ58gTxwZz4xtjEQhnVRHZMirwZpn5S0QkaL8U-qeKGXRpdyGraySxfvD3HNce80Dgsn_Gwqd7aXux32gd-WgB0KvSTQ39kycB7S4_RGaIIZAiDaWmZzoAvP0jvs0wnf1kXoRnXTsFP7gsU5N5TXtUWFcod4cP5-JmjkPMQB-2CB_z8xJ-f4D82E1qwxqOxMSTlCpfDcZneCU4fd1_kUahP_y8na8UwfgyAzd8hrTFlBlbtkG0Ad-B2JAZ2feZk6SOoDLQxmCavjTaikLWdTa9cWVi1VTwjv2ILkCxoJrnwbc9DUiwxsXvVxY97KDW02HbXCaWnrnBXzkR4ZyUvnf6IERBWenoeyN-81pv68wVTMA4wSuUq9Yin3rR4mq2Z4_UPGJgA7m8soxVjVmw0z5JSlx3Gk8MJyOEpGsDBXuVFZ-bdukGLOcuR_20KlGVd4cD-jR-PkhnAzSp55246VpYocAqDfRCkquceRAj1UZZ4zo1F6fFYMa1ZdRJzijuOHMqLCJ4S7o42aR3XN6HmmXZVFx531vKFs1izSVoEFJuWhHoE4-SKOFl1jwa_fQTowh2jiSmB67U3xgbsjkz8eYqN9cEaVrFYtGOtlXQXM8zdOPjhiYJmxNXyCVZ1ezoMYfsRfE2p4-LzkSEC-cMUPeNa_onyL1bCGs9-gUS7g43zs2KNW0IaKDmWocph--MjJBdcv9vB5p0s4G9C6SA_1nevRAjwcVd3G1F7LWp_dMs2B5hgMSf0U_-XNgjcooy1Oci2nefsWwiO-ox8B92xb6PIkUqOzJkXelOWG9L0btiwZn-5KzbIvLA03fU8VCZ_yQExRU94FOfqTX0undpnXvV7DohbgBNnyLWxn5_KBnyaTAcDHzkVu5ezKnfbGK2bC0Kyrn-e5KhztvK7yBq60vb334-szWzfMB-dDEQ6rLOZcUhUQFxZkN6x6DXMXWnODV1Y4k7XwLrQ0CVwjcwXyr9MH94PU12_GXPN9Rt6WqupCYLTCyJqFQzRYx0-p6-cOpx9VupWrak6ju1GNG5v_rsREO0iPvl8k8PwgEPFP4R0OLgCqUm_SpFaDgWgO58kdXo6Lf2T8EBp0xH9-mQuLEO4ELf1mdRMZhep0D5ZI2vKKnuoZYNwUos2KpX-CZScIqP8E5-tLYCSXOR9dHnQ5LvDtyVp3VZMu8NXtyMo7VdM-ZfJtSQ6vglXrODQxe2vSUpidij5w2PGrX9ZIae6yehbKiAI7OD-YQlwSF83tbJdMKEM-NtaRptYAX7cmcdlAK63CLVdXWuX0IBUApCNOQL1TA6M4B1ercWPccIt1OTmJDTmLBvLLxeHS_2jrCYaXoP-q8V76SwX41bwcRP8tW137624vflg4aco93msFzzeoU456jF-31p3P0fEW33prjcsVbx2DZycBJ-vHdIbfA-N2CfaqfqCgRNPgOewKgzL1NHeCxVuxTYoFCih6KBxCAQsnbuPM6TXuwcUA5rkGV7oQXGk1LS-T-YzT3eLeM0tJj4uhQuKkRxOx6YO5Cfp9run_PyWlUUqaVUGa1-tGM37W3hq_9GyGj1M2WD55TGBA_mGSIUTbpXMvBkcvl2h5pPiU03ySoVNDXmD5h6N9ppvzQb4ZbcX0Q7Mxy1D4BFy5G6zVQiHzNOEpBjhrmpzapDu3zzqWEfBdUkqX-RY2AoVJHFhr5v4hVTdONo0rfbOL5bHYg-tDImptGKlVS_2IU1l6WLgo0Abf9kQ6XM0C00G3sYHntlU7i1tJgwBfp8kWHsmGMXWPKj4jnK1M69B6NltYzRljatI6MhJXlx2rI72ZmUbof07oCWn6ITa0hdjdaMvm8Pen-PLJoTAz6e5exdrW0uERZiTo4hc_U5I_82l5oAHvMTi1UFQPPXyzDF5p3sRKdM7kv6ll36ghGKSYx2dadp9Bvoi7QpOXd7jOgFjWp7Po6JIPDkAxFJkGqzM3K3uK0iyXrYhcZCoUnju83zpwfdzwliSwVqZbvP8ciU3I0ItZySZ1_45zHHMyc03E95eSB9lysvOCmnlK_Lyba33X0CmCEaxGkSKSTb1L_82OSmbWxKrRxvw3atbHWQwiq5cCoZvet4yQpRobyIJgZ9-d4VBolQnvCNsES9hlcj7R60QrioOsk5T0PQ5cGFSqBzlxUHeUOhd26WDVa3PNYRZSlAs3O-0x89LpSq-FBgQkpBe4qDbfVl8-_WdgWHqM3Sliyu0wAz4cLFNT8R5TpAE0oDfoWpHA0KcF0_EGEdt7SJuPw3tMNBBY8qwC0QedWUjihwqjEc2Ygkds-Uhd6ogQUY9FCJgfjDKfhai9heCrULZ45bcUTfaxdgY4LOMOhCJtPkTYb_sOHAqQpFYIBoEDPUrGqk_lRaBcyQ7_G6H8BRbAiED7IR15ZWt-IUCl6WT5UcZD0T1iHRcOi9GlnISD-njNqk-1L1KEZevH7uXv1YdQJH1QOEua6ff-7XyxxOl4mmQLLbDi86lNZyfh6Ra6mVLi3CCdpd9BqBzOunBB0IDJZK52awoE6Eqtc1JOxqnZMue1aQFXLYJdYtVK-hRzKvcNMrUnLYCHm_LIhWO4a4lbfireLQgwt8SBGo7CQoWe4zMId97OS5VqpgSGlyXyXlHxX2vEfi3Y0Y09_wM_bwvuthUC3JAnUqWFdzLPVrxZg3bsWhoCcoGJULdx5-5m4yy7tSYtgFSJA9V7ZtlSMLsUvUspyvUqhndvD6jHdtOF1xBXu-pSvqyIei_hGcrC4q8mXccUogQMpq7mEnYsj67QiUL_WBwKIy5nqxs2puMsoYtaZGbpJ1U6x3RUC_U2Tq848aFUnfV_dI7fS0xG0Qr6SaluiSKHuATlK1WmrqnGAseiSF2Awz79Dpea3y1yno8YnVBHdE-yYWTPPZ393xrZIAzIcYE4CX70iNBEatXmtt2Kf5BQ_WqrQKE1zYCQTeqvXv2LTuzUHDxhc_eJlB9lvWOQ_H5fOgufBQcJ0rffv33UzWDrpToaaJu79F7QqXd56AKw_AfxBUVcbLtL2_018mLAJyAiykO5yc96dOB_UobuCt2DLAhvESKlaY4iA6qcmpGeEFZ9DqXgV1-xgLKnam4dkbQGu0QwBgGkAWxekxN5TUgy5_8bQAuTNfQFlhW2UDFYgQCcHi5L1DTHqR0VHjgmW1Fncy554aH98ajZHiXrAD9Fe4I99CZkj-vN-hznYGJd1uOc4NoP9y4s0JiaciAjhe5S8uUfurr2W8cvPTdv65WK-arzrH6eRzgxi6nvhdfuUY3BoSBW15Gx1GKQ1qZMlvJdC_lNix2LsdqmegJJuzKImuh58hZyGIJW2IqFodDEpm8eDLlNvpOFRLifXg1ChGg47eUbGYhfR6fmVHbpvYA95JPVOb0a3668Kpixp-e-iICAoThrzgzdJry2SXNqjgaV6Q3Nwiq3yaxOO6V-IB-Oay9MyaW47oEp_X8BBdLyy6Ev-D42prZgGJcF_dVzwwLUUZtvtuT09UjKNa1ysFWMs26r42jSV6302GsdxR9AxNJW2_oPuAHQrzr0hGbi946xiysl7kwex7LG-a0sm8UAJXh5FWdo8Nm2QUEIAj3KSQUOefx0MnhvJ2kON8F4FILQIus-JenYGwbjhvsVtP0p2ENeNX_qBh4qWSjLhILpZqWGlmHC7lq9DK-eDBkjVjebqgvJo9gYsCHxb-8iB7XcIbQu__piNTDC9XRLLmIGUY_THKxYl1Z6y8PLamRkc5tDTDBbJtIN7LyJaYJ7IFgJjU_c-VhyIAssnuCe0ZJNnACd1e0GMnhv3A54xdgxFxIZ187A-IazqZ7-jE4zrzhHZ9PrRTD0OMvoMWLHNi2CKX3Pjqj_T1TdNqozgZ2QjqCuXboY7BgX5a1o3aX_rvCkmGHVWMkc10wa2PEciojFiRqZhf47WZFihnKvslSCSqpM-L0iVD7R4u_Cg5ledubafJy4oH7WteBfVd2y03mjon5riMr9otDnECNd9rzzF9qbvzgeWFFAYwAhxDNOskyktDXWsEV91E6wPu-dQSU_uegTNX3PzWIxpuHwkqr2CcsRvMYk9niJvzAvHBIABKpoh4JJvaDAUbh4HNU3X_GkEYEwi5g80u3AF2P78qJIbB0-tdb_XNTRvg2rcAC50F0e7Q2ELOrR56cDkas_pfNv9bkEfWsmBzQdsELoZKSSL8Ki1m5rGoGOQVjKIL7SnDau8OzfZ66Zak0dXbOFM-gjFQLDwJYMPqHf5ZSHs9aeKC4s9XmOFvBjEWCYXmvexykzTJMWBLnqsJKshL6gO2Wgrizlw7M9VgeM6VM5bjH_9vT2pzZhpxKa4EVk5N2EchYdt2ymIML_zrw-rkb2SKX_Pew:kJl9sONCtw-RwNkCDNz1lA"}', 'first', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', NULL, '2026-10-25 17:34:16.126+00');
INSERT INTO public.snapshots VALUES ('26483d97-1fc7-4e4f-b947-05fdb7258cf8', 2, 'sha256:5d0b4f60bbc595be3efbf57e3e35b88538c3b25cc625d69c5b30d9f85b320b34', '{"$enc": "enc:v2:k1:1WY1ynKl7qpLWIl4:gteHwRY-4H2dN-ULgOu1PWDqD2f-kBwtcWYB24BRXwDVYrUFso6P0rvyT2OoKM1w_f6VHL6zvK85grZiBXbDtn8tUkEFu92u1Dm8JRtAHkjNuWtg9MAPUa8_Uc3NvKhV1_1U49gGVOzxtYCsC6PfHz2ThacewXq9qp5gunDCHrFXjWMJUKx-rEUt4zbyZKplO4StWLOjxIA8e22PUg-AU38boV6w2_YHf6QWeOEpeWHoFnG2mbSdoMaFoDciCWGDrZL03SBIH2XdWLVSlfHj5L5WGvF3lMn8YjwUprAx41_AunAn4h3rEo5S7xBiZvZirenHQSOK8QYVafChDkhSKEBHvZYW5Ldnpm_lQtJmyOH7BKLxxzCKpML08Ogznzh7ObcfG4VnMGFygzhO0Dg40WqrZACCguH5InP8a9b_likrKGmW62mqc45I-EI5ZR8UCqkuG6oACqwRWAP0UuSiYv4PusLkM7iT4MyFJgnjmPRk81z2foHwqowoyE7FSByoe31hO7MsV2XsKTAW--i-OogcglfUgftIi_uA5_of9OmkEJqYyGc1bGC4Lqlc98kDcBz3TZtt2WGIVu1kvurvBlUne-tKgRq8gXZuhVOPcMQcEZSAv-TaNLaCPAyCmoIfsGf6NzqpUOf5o0_ErZB_5UNxpIwSyo6ip1GffF-Tv1am_oELwcwTtoFtyMZi1TiPd4gvO4HiMSfa775N9igd6c8alSuBTQYDwMzJ0RvrC56QWS8MQxoCrqB3UDH2Gzcpx0g0XGJVSdCrLS-3pYV3cRIksRMYRfcCnh0F15svn_ByXuYx8P42ELuRN3llZuL-MfeoEv3IQMAomYLRlN-pZm50nIRwBI7ms0ItKg1gFAAo4ixSEEoFQh9M2FOFlmCkF7X9635G87ngYU4vTlc_s0VKHNozhG3DIrOtjFA1-dN7sljj90NDjj0nhsWIJatQFZntuXVs_1YpKEylbxqEA8bKwVWvHuWIyG_MKjXjAlDacxrOhbMMhHcOcB9jBGSEXKX01R49cp7Jzj1nlW_vMIBEw1uf3G6lGe_x-UbD4Oc6B6Clufh59USgX2dGtbnk1T1i3KEpDF9syHWcwuzCSii1dh6BdYXOK8Vz_jDqWRAXrsR8C9ZR8Dh4jreLmtq_s0CWFRIWy4tG4ziPKWUQZcei-UtG6G_YIEKSMPe4HK6YEVzO_SmkZFM927YXQq7NuBVYnozR6mlrzWc6-WwXSPCflyPad_G0lweLdzq4B6z7CIn3bjj2icJGyYEvr5gOjo30QAqgXYJohSZjuIN0p5dc2vP1PVEJplRwq6Qfs2RNU5WduVhfdCkT6K9IWhIeNLxY0YO-C-_1Wvew-Jx7d7O7buQHSw32aqIi02HUuitKJmpTsuMkW8xkWHWY-HZiQ2hU-ds7jxw-vVbGKjGcjj3tLNuMhY4nisIMB8rD-E0Du1oMKd4wrrY3K4vJNFrc23nDBBfjOdlDI0MwKfB3PFRPZRmpuvLW5nzCIKbAmV3qK6LemICOiNelhpB0tXWYOF9crmvtDYz73az6JdZvmTKbMsfsZrrq61XJ9B01_pzNxAX0UHHVG-GlyVQplk9yNp4iOVB9Y2s7aXnOFgvosCkIuFGO5tRhccP5BhYqq8mp3cMQWvdvNZkGo9XlmbLeMaED3RG_tRI8NzKE116xIS3Zug0S-vis70lw8XWj0s6QB0DMScNpG45kQA-ZSjQ-XR0RZS7SX-8iIRveF84GYQTuJ-iq1QloqzxdOK5RD_RUJ1hwbhOYGKpohrJyHPBUvJouHxdxrduEFlxrIO_FrNueWECCZdyANc5EK8ONVpDTLnh0IIw0gqJtSGwAaehAvCmNAXAm8YeyvQjsEfkY8_Z5J_7Z_DbjX9fS9qJ6c7LFcQtvNTQb5JVhjLbdGNzsLzbEolO2-4T93XdfCffbh2q2Srb2XDC-gH3HhLTSMID5YcQvqlP9ZfjPpmMRuyQ5X-9LWSgXCsobV3lRLi94J0ahzLQ2iYuoGPINdMA1wP5cpQOXvPPv6T_GseNlZw6t8JvxISTEkTikVkIKeJI29QfnKTjzRVp0YibjrFQ3WNIFpcQliBSjkM4W7bTQfegJQ0CXuF_fKn_d8p4XmF7LRl2t0AyMWfCQxn9KRfJk2et9FczEj6YzK1hTa9W3pABT5NMBkf56zuhlZ7FuoEVhDYM3grE38JCRRka6Rwgup1qYFJRExqr9SqPFONU4gRIoXQjT2Rg18NmyiwEG9lX_9Pg4geXjPIJgJ-k1KaHVtJvX2cviU1dh-Q9xd7ajq0HKMMqHIKzwpXBmLcmZyKuyadasK-v3fBnEZCC22A1_xVhs99zVZqrsqpNYazMGQ5qp8a92fkaNusyBIAn90otXZUrWYjAwAbLC9zOg9zkj0aghXslqU1MB9OycJsAwKVCWuQhLF2W5cMz2C84uB_VE1gkRP3ITfPWdTIAfYxOk8lvCQ4DGtk-DO5ErC0bEdPJ_YGg1sOussWDKhnmgiQFSBg0hjWtjCRHpH4kYlL6x57BTmHmNbfEJMYNxydbd4yQd01KWFOU9CF9o7sUF2N_90On0kNuxuG3I34Yvkl8VCVvW5xmGeGqKHexsJ3M4de5BKeiNZKznqD8dk7g_cZYN3CwsiwTWr4odqF6cPmyZU9MXwDsWW2E2r68IogQ-1N-40x3DSM57sa5nJzlGfXGkHTgBAmJabl8WhvC0yRYNYqM8o-w-XjTBJkJYLX9ZcgXo6UIDm1JjiXUINl2_ghwgZt3mj2S5K-yVGzIOSOJ-YglfKF5HWMSKy49EcxfUrWLWqy05mRR-k-bCJCsk8SGW1JtcMTdUkN47Nkxz3FETdnSvUoxbErI3hHXxSry38R0lO9Fo-8wB6QGPkFcKpBHJV2jmCqfBmUdmRojT6nNJqwlC3DRYqBbIxQBdffxjzHWQkC4lrG4m_nZ50lSiuOlAAnSjnFEXP3MlLvdyY7_pS2DsJM5aUuscZmUooABIo6FMw2LLxaKSniTKzC30zOh4WLKrfLI_ENoJWTgps_zQ3j4d0iMMi9LiSdvoTmjRSaVrpRyptUBlfS9qA8HkALbxte-wdXq4nbtTM6pTS7Hw3iO-PIP61ybWssPN7SaGiAjXj5YaNtkIW9qRfXFqG68k0WQYFyESHiCPwXmgPsg_QZlUDQslptZAVwUUupOIyfeZD9FqROoO6xKfEOPQQoZWlJNgkBptbiH635wGoQoOkWYbdPM3Oez7dwomXUVHjLmaJqU8EWbNFTWkt0SJxMfaxkzuSqIgsGhqGFqmNC2flUiyr5njgtZ79crFzreFfbEPHBnEW4Xo9TocHIv3jC8DqxZj4PKvecYJBfk7MrDdUEcaOMuPzk-Rdrhbrc3qFjxCQ6EhAKebPRoa6zXOj6Rv3tYupDMm_0dvKExn47PYnePF9U2aANcLqvRQ-tZayC02mdGzNSEb_pVnVwLeIeZMEmYWUvY57dofYv1zaYsEUzuZNfIOlwrYHgWMxDpiqLNjHyColCYWvTj9v-w2Ny1DIa6H_7vxIK9ppliCscm9gFMoXxSvVlA8bqO5xyTX8AUPhiAv0mlm1Jv0klmyK0KlU1BwZfNH7u5b-yjK806HAwttYWLnVg2eni7JCkHzviCCQCQFxVLPehdo2W7svXJ_WdRZUo8_4vsNv3ReC5DVOitsP5ZPXjLTvkrEZQBvCU_2ER1ZKQ17SZhfF1L40X606HjOBrT8Km9kyj8SGhj55WYi_u1ZaukCIEbjqb4rnJMyDFfSDJ-Ta36-BzOvtFr0dG3yE_wO1DscxbRgjmodo0ao6xDzxI52CkfeGeFIBcnkV1FD42OdqLLBfnZGG0VBGjU_OyoxojuuCgaPYpYKb2AxyJFfd2QyzRDqMc1KS0_Pol9hg7Qo3jXdvZ2bPxEvW7Wwdc1qsXQCccpiVHRPB_U5FltCJ8pHFnMhFzRNfLJCQji6J9vlgetqZ785LF91ms4lk8Aor7fGW82x5JtGOIiaCJYJJGbTGwqhMC-cP1MBN8I-lkEgoThcTKtH_tsZWHH91jfrtzSFxNuSDk3UpRqP0nq5MvMIc__BXaDIcNj8RqpY37-Ct0B-OFLeJb7fN6voxMb8ti34a7YqjQ0uBLjA0-CASgcy8QHaPriJehzKXbYwsIrl8YSc8J87XuI-vDYrmW2x4kBC3JoZzGUrLr_06glZCthjW_2iQKJzIZkZMxeBUFLAg7M4hHvZ_vRh9UM7KJ8Ju-79NR3mcFEbiEBEmVpzviQQRDqQjtipJqGWrFwsmaIUd84Xl0QRxjr4pK8ymKx-_YIxcgYWKCHEln43mM_Rah5szlMU6Kb_bG4_lFWArhbwCf-YzoGCm8_qWN7a9nbGRyF3IhANZVJTejuxV0nRsZSfsoBNYmPkgPLS3L2VP7fnTuBRbX4g4NYU_0U2GNlEfpz-lm19ZUFMCA8RRAXshJ1medNP67MhtfiKWTm1BQ7ZE_AvgiwZawMQ16EedAoJKvQcwaPGefO2V6WIaG0Msoh_H16BqImOnUvRS4RzWai-lQcwG1O0TS8X9iQPko0YAckmOzBm1MRL4kMsmzbUU-_DSsTE069r1PzFlwPsTkXHg1YjIAgBKmiUiWFhG72SmtvOxiDHUHZmWFS34Hbve8VCpPmV9UOd-xH1CgUIHUwPw2CrVX03bpPi5bJjJiI3yhXDOFnWfW-MWUTvGJzMWi92lWEuiUbraEJiKOpShyIGlJn131rTU4QMtWaW2hnerzGAGoSDmYfZ2kUdOmsrJa7BqpoUKy43byoi8XNhorbFeXlEB6_I6ephEI87He93tbfV32MIMyueOOaCGPK_TwOPePdenNmodQMCzsjo5isKyipcs-FFUVwDqzxoTn3maXTZWmYJXjPWuL399VLGq5YtEPitJ6qWHK3Z_sdQv3Zst60LTU4H5ryHEM4wdyL-mLB4gBjcg940VAJITLyt87RJtoL72WEqzcdvg9xuatO8TdIWBZiDtcsoX0Wf7rBEaevS-XRWlhuiDkKpLWps5y8x16w-Aociu9Xtz7y9kd-VSqycKjKPmfQQdiyaIye4mM9R5Iamfvqap19dn5OcQyAdspIGgMYgTZrsnqLkrcfClcWD-dAYUssiixUeMZG4TyNA277XioZvghgcjdF7yJcFvCbOSVCDkuwp5LFKv8yvWPtf91qA6eZooXPMHJdX8vwfM1yi3p-OAVMr3exDP7o5thdHxTIYTA2vz6wlOp5Qb4lzkhKaIPYs6NLKbEdGri2u9RgcTvFANmHUkdS37e4Q9ekX_05HlIR886Lzc7UzFKx5_fws7m1xMej0YyQUdo3laTq9CRVpnHxz-NP2WT_DO0-rhHDK2JRuIDC88cyY8dkfw7MYdmt58YexW1Lnw56PLLZC7tPH_uLkdexS5m-F0k93X-0GyPkCIpHgNS90v1pEAQ-q9jd8fiH3Dq8et_WiO22gCeBCoKwSWnGX3lRyxQupzxDdBJ7VC4tkd948E8c4PGHtAMctueG7X6bi58tkrR_aXVmFxZpTJV7WkKgMWjOLw53Ut1-tloHAsLTNlHW2JiAjaORcqp6Wx94b2wVdhxkPs6XXWMNyL9rNWVKdSGqKUeBcJcXCzHK92R7kRnSBSAYxuZkGIEirSNnYCsuKcEliz_gLHT9Hd3NB5SjPXoUd4otZX6t-3BLiorFc2smYRtxSr8QoPUrq45oAgqJrGY81dkS3p3JV6rwlvKzmYl463O1LsOYwzhKFdsXzaZJeSN_f4din3G8UQJfbaAWfzt_MBaufLZHWbQw9XlTOsAnDgfazHan53aI_dWQdHRrsGKrw4t8y4Aeqq-vTZRm1pwnS2ZpXDgQzmU-z2tjnldAri-sCIvndyDJiob9VT1gpOfMeCl514ZXlx0SdceobnPTj6Jhs2Pd2qs3kqylOrDNSQP4j5rQyey275ZypiKOWhXPQ_dOfFf8CyBb-x6vejsxCemiQcyx28C3EOT5QDd3f7M9J3m-PSsxyowh05yjUtXh6RyoXHB3nQJHN3MMJxke5HvrHJtg6H9wvKUgJCZuGaf-RQb49LNIMmGcLs06PsWiddjjWwTttOQkayCw_kBG_HGwVu-vcxdFHwEJTOhyXuW1dBFzwjG-2vNyFHpBFzvIYFi4H6XV1Z6Jqti5z4NWNeICc4St5PsHxCsJ895EhnCDIU2sjNVn3Tjx9Y5G6QKgOMad40NMcKMlOXEtYOttpleZ1qJDyZgC6MrNybe39xSUdgxvvO7MzA9n9AcWHG7B_bWgx5d5aDV5Ax6u8Annk-jQQf044uZBMNHSUBpXZXLQt7SmX85LzynlLuy0nA5lTwTcbPVNxVPByTRemddwGiDU8skLz68N7mZcpdjP9wfLXUJfwycyf-IiMm9koBB_xnjfL5T0Y8cHM6MJ0yR9bvN7T_XqTLYFB_rExj_qFA6BlJUzeXRKkdVKZ7GgpAtRDboE-Xhab_vlwuzUja9PJj2P0CPktVEerMVk4eHnIFwo8GqFn2RXObJ-EbZeW__vk3Ri6qACOxILmEMaMnTKFl54mNaAauq8YzdXnnIlKqeLp2EuUqD8g-D0dJIpRB9fK:2a_qYsfymcu4A1sQjkAOIA"}', '{"$enc": "enc:v2:k1:TpBdVAQiMwEbtycI:AhF-eRtSvWciBr8pIcLrFBlnGPp5n0jwvQeiq5835OkiQqYqzDSl5Tad17W6FsEXIJ0V0aTf7eqHsTEeHI4gmAlJbuTKvJfoOdD3y2jbpx6gfYdaUbU2q7Ea0LWj-9wgdMZVGfK6EAHxzRR03l8nucinnP_rvrmmyYQN7VMgYR76ZhI4R2RW-CeU299wL0upG7fzH6MW1rRWwTwICsuWChJQi2ELzRSs9oR2ro81IUr2IZjIY03AhpZACV-dtZpXZEsjURsYjxICD_y5U2f2XDZGigkjSD8HJ7QhGOqywADSbyWDXfp10ILjqLIeevXih-4-O4pwDhx6yUHwAJYXMqXsZS8B4CEb4fQ6CA76VQqyYg5MF8Rer1I68NTvHTn1RnaqDQpCW_zyFgAj7ONeZtrnSOf3ny8C1Eb6y8voX8483mpuzKX_P_7n-8kbxD_niA5hxEP0_gHli44gQpyXrQM5TXOkN6UtbJpAGNmzlFKmDFVDObejAmKEdEwCB7UwGzMG0Kx3Dcge89dn6CRDnyM6EpR0Lzhu-5rzCqb0bduBQEDmFvSgd2tF0OaNN402oE-ZxkRlYdKTP1gC9nNdEW8a8gSO-s38EBz_unJfTPatv71nFZyxyh11aLQUJr9VfUo1oyW2C5F5ptXST7f-4huloNXPob9O5O89lcMQwS0G2IjQyN0iVSAfAXQWSf-6LRBCC6o7hsLTvkRMZs4Q1xmzV4r8wt3XbLvexWD9zW9VXIA14NOy-JFRkBlh4eam5pBZsVyMG_jwYu73Ib51jc7Iue3KC9fU5aUZDTGT4LYzE3f3qqm1SWj0_G-irc8ofWsOJ9bn4GG39OTqQYQJvvBD2B-HxXpxQh9z-14c5huHeONfPOLbBjc9JEWQbm7z9h6T90Aelti1fMGd8G1C3UeNOBBWchwL-W839ag1d1kj-DF7OOxb25V5xPtjKenqaloCTJ753vEkF5K0zG8ZxMyNmYtjaKmt8OnbK_ZHbtslj4EyzmbMf35WAuAemYvmeRoiNm-GVzCRGToJyk5hWyeFSRvGQgM3-Akv4agLlgZeNi76l-rxOIOcQSbcCLjvWK-kjj0RnnwYdGCyPKOoab8eGhJ1pFINobF7xlQLPTIzSrqu58BF1m63_NGuUjzToOB9alF0jS4lNXnmDxNH1NK25TdUNAULIyxngfdM--R8OUApIoqVL5AWuDCOBsA_pPE0kM54SKl1VLMkYsf2HzTv8kbsEsv_xRwnx4Rqed3KX8BhH9HitCYeiTWV-FJ95WgEXGX1YG6R713Bn-YFz49_rgV3bAx-cxrVET0hH2MNW2ZlavKG-Sqd97iOgp0kpH_eKJrmyqfBM2a-dwKMUMkCcgJdFZUQmU_rB95fS44Xobcqz-bhjvT5uwoPMf1yaph8uWubWFvOmJAPWBj8Lm1P-E7sZ6I84klw3QbqPJoOYN-S2nGji4vyKIVKY8amEHHrAvoQKdfzAdfBpBUCAPrKKkANzxq7-Dqj4t1imdx8QUG2hjJPgdQfyJo2Y0niYn-W2K50ukiUmGz2ZuObmVDi5QfzpxkSK913kM6YeyIj0zgQLjw79WVGzO4G-wdSzgwhWqwIaPLQR44PafFbq5-lvEIk4ENTbIZZwj1q8V8wNMHHeP-DVsuQZRn-Vci8zbUin7SbK9Ux3MUvO8yGQnCMpUgP0Lwy9Xsp5DWdMticA2BP_uDGHuAb5HbNgNlho3TnSJ6XMvKTBQaYsqQy3Aa2WdNxRh61Kb8r8f_eLZS8dUq1aY__NYmJK7PvY7vRSBeOA3UQXp23PUCdyVekUW698Rk53SpCJE5zspfh19_J9OLjGzzjIOPqNuJvrdv5BXCJMG-QE9KcC1h0WUv7yhaTWPQXEyTuFxntKpB2nxARt5LeRGw3CbkCyubGXHAiaIYQ4DhnW-MJjH1fyC6pt7l0cQM7ywRYjFoHNpY1ZIdBo-UWwMFZrRCEueh6DH9auBtdj7Sc9EZvKvc7_rczJzKUqoNqHjtWQPAi_r65gotCCMD2yiarqeGkC3EcUso4SygDi6uuh6lyGKfXemLn66cLJqmkWM9ZnnYs8ONvV5Bd7ocGZi7XvuXAQkpOhtwXT-fYaR4AsW8M4aNuqA-HDasgvCW1SWSPOFYjolNRv_LR8RXyc0SH2PccbnOROM2OpMJC1ktSRHzlBY3rV8UX1lm8I14sBT2fS_yLgNwNSVeeQfWs-qrmtKsdpFc_Nu4cMDEI9V_nfwzVsJZXTc2ejuo-Fr3GBH7oBNTRCP_EaKhfvgfGy1RIpwVZCxa1_zmFwJvQhkWbOmUJWgicF-pv2HNYQjLnwxVolc3joKX36zIkervqgJP2nyzIbFWms3rELTXoiUZQkHHSAq-jA-XhDzCnG45hjWaZxwDwfsRneKBvMxMAfUiw5m_E1z8HqPeF94UrsS3iFWZ3Zn1UNeJ4swafRx3einCo-Ih18bA6arc1tTds-eHZXtS9h0dE46kMJ33RUtVQ4Sq_JHEMWVpi9K1HkfKHXdBMfTWCwtFX_shjr7brKMiQ3YuoWv4PYabVPu9rGRovx9WJMXazzvKKk53IdGj9iuuYf7GxhoMQIktL5qy3NOult4r-58Z_ShIuinsvNaEqg73MEwUd6ehkzliTxncGDAK-VYlI8-BDFpZAZH-cOVG37nkabVQq2njcDVMJPBZIFPCzVJnKxMDqbYXxxikhTICIivv_XyLAZTgTaZSbv1oLA0PYUZ6jzMjWquCtDt5Z1Ky6U8TWSSioYzcTczhkY187STmbH8iCY2za9MwTTo_iLoFZK9tgMIUVDQyXydGXhqXiThDBmPoxI6gpqfQIQ48NQ63QL9B-ahCBkXruGBy5Et4G4QltwnCi8Vk9t282bVhZRjrIoiJca-d1m5vTJ7xYbPQ9Hb9quS_g1AqIJ7ZRULfxk-fwfn8wYm-l2eRpBxOSE1nTSssYNYll-nH50GlkYPWQqvHkhLE8qtxmGdB_9Jxg_Bnus9XHnlsFYJBQmSVa4hhb4SdR6QlmaKXChNb3sWYsjT-NN31R1Kdi_p0xgbYNYR67KxkBF6bS_d_zozWuTstjHUU3Nklerz-Q0jtidZM8lw195qLpwDZQ8DWqqCBtz6CQm_OO4bUm23gCFuc1J2d_8VNNcI2oocevBV022mOqSTvd0kRTETcALcQKCX1qyDYYmiokmi_vAfx6mSFaO4uFXQtikx_i7i4dRuvwrKmRvgykpDcq06iQaj71sOVN9e5iO4Lax8IGzCrKuckC-5jQ3S0mr-Ix0tCaBTd2kdVItBqZOeqTAxOXIMNwC40Tdq9zLPhLxY5cmssvFajIIp2qeIB6jaFw-RcZ_wL1DsE0N6p7q-mPJg8QnkKD_3AkeyOdb9ztRjiCV0pbXxZzIRXfZWLPNXylOiBIuKoumAgT9By8zUf-pzbGyl-4yxb3hBLkgB0misWjpC42IvRbv3OP0yrzMbFUi9uKefYtbqbwal2FCOFA_mJtVCLmKaxAoKFiUj9-QpTu9UaRj3DM4pxZNlqaXu8kOKltMdL1tN4ZJqOjTIc1Aq7l5Sp8SKSl7FbilwUZ0gxnSwqNovcwxLfjfdjLN2sVJsMnasM2quEVYYuCbUhUG2UP94_aluWhRvrYW-KgCyaRAv2wNG4g_4Ki1FMHA4aHnONixmK9xybdKNCqBl7s5LyCB8Kih_h6vSK_TaZPy16frDb-df8ZF36pyWgaDEssRRsKAw8afBhlg-abl71ZnB_9EbN2Fr0wbWE5oHeFRMZUeRU-awwt61uJBPqCa1jcHqaP6X2osa79tH7lWtW2rAxQYo55L-Bp044MnTQnupQZxWNVzV4gQP8-heIK7UqnJXWO4f6gzjReVROhizgK-GgoThHvhBaWXGr5PApTH0fPHLcwT5fm59qHD1AWFl62LghFd8G7CdzxGTkGUMUfyG9jZMstlVp78pXlFZowrrrONv5ICSHYjQw1QMhv3r3qS_2HbGpDHktrG-ZE4uD4cCuDV0G0AyP-_HxydBsMnQ2n3RAVeClgSoM2D84bkqD-dQjgo2rWp6vFQe9xpjpuaZHrod1KlVMQgMCmFVuFn2apvV9YQ5Gej_uB7yw3f1iBfAJN7XMweNQxjHxFyk74UZaFnwO6UG0ycUYTWh54fg_dIPHjwPR_9i-TYGg7I7LebGbJ_OEfh87ZbQYRe5J24MwRxkoRFp0aPzl8v_mIPMkgRVdLByQMzgSfiU2qW4lvYvGQj6baR3EbtaRQxJwasfDZzSe1euOaMFkdVcRc853RgmAscmm1a8TLpQTWQHtXtyh9FeaRYq5wjIKaKGWiHRNT1APd2IzMxjFBHpRrY1vdLVS2UO2mfo4ZlmjJuTUH7TdFLrXegyTmfEI0j1iGNYAhftEH-bnuvVkyYij62Y0sh4MCiaArKvYFqlXg2UaELrnu5vxr2Jr6GLJLB2w4onYiYUIIMXmDbW3rhc_4IzAnpOS8y-W2ZzR3AndHYW6rL_A3GdI6kATt_RafsDx1ZMso8wKhNyOxF_w8cH5MK5Usprni-ZKFNZ0WLp_PBh0oIL6vGsYlnWZSZpKGGSS14ZQjCjWKxSI00cQVqLwfB5DrLdsvZXS8v5h9vfx2T5bp70qMpTASCFJGWRDnWh_EwYWxoHZSYZemMIENOaZ1U7U5WvXpyDX488sLmfF2odu59bsGJdtu5y1YkjDmLRrHRzzbpz_64bOZTJw-329SofPmeA86-R40lHCBz20d1sweW47aD267FCUF_kdkbHirR71pO3uXOXJT-Kpz0wSlVAG1E45dG--6sPlgpA7HKqj_j2mOa2NLJHssWuGQ6HbxneVCPur24yRJteRhM767XEl0rdzaFHKU2FJ1FEFnjSMIX8s_QGwihcu8O9JNxI9dy1so0nf1o2YmeUmeABnHkUzzo2dVG0DtZaUJqWtqU7n5LbLI5dF-6acW-0-BiffNZD6mPp3VdPktTE6Me_rHoEbairidcR0JsEX-qiCrS3ao2BR0lYhjeRH17MWyRYEYlF091z8q7oP-hVXSxLe2ZjeZN5fN34lcOmnStLT9_2_OkbHGyD16UDmAVyMZW0FqYO1EdmMzMyCieIJgavj0aCBtUkv6Hqam1_OB557HdMDZ44y3VBcahmYZSon3_9-iKAb2nCmqR48pAVsbRbT64N2Hlx12r-AF_wkVLz8Y3Pj_IhmpAMxWl5auJXqIJG5DHC_J3j5vzWFKdh5O2saMapZY2AGKFSfqrUb3uV4j9GWPu5m3TSk5_HfdDYZkQW06xZf1E2N9Qv7lXpMLSKJG-AthlTh0GFRxx-DUGtFRbjWwnsEWtf213CcOV_-ZKIygtkkzHgesNKddR39w6lACZFAJ01bWNLV7K9Zl-3jT8IwUm-EgbJ42Bn3SZCP-u-XlFXFdpz5gc05E7IZaNsXiC9Dfb-Kf2iX-E7wNAVqNCzv-DJrtSAPaoyvQLC4WRxhKQibDliy29y6yOSBwWzVis-qK8Bl08uwa0GTXMgijkQJnvROs7XA6cSaer_CtN9P8Yw6Zn-MqPzIavGtQYBFjMLwjEdG5entx6HLmm0uwsEi8a2TGc13fE-2Q_vDDv4giW2yycT4N5FSzfM0TadZpHwxZePdT64r229dTyT0gVnwIayCbzcNTH3yhJoBWrm9ddj3_3H22Zts4-0I6VU0SmMdQ0C8G3cgejW2bO5VTzOGnaHumkDCiKEBBo2VsFqEUynU_4L4CxodqoyVhgbBAM7S1rIFheLbxOsctJ29fJWEJn1WGICvdPt9gqZZyx9ksvD0NY20jux03cuZFFGaOBSWj1eUG5hHZeAVxo_AG1io1Xdhi35taO115hvwBtucesL34UNucVdowbSuKQtAZjdaZljIxVw8ZUg6lKq-LEwsEab79fEtVllWpKNR3G3PPhshBxpA7vrEUtAlqR_iTAgegd8TOqcWxpnqGaa2_VhPjqF5B7fkuSmn5eJE:cyxuGzmUGqlck31crVZ6EA"}', 'second', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', NULL, '2026-10-25 17:34:16.152+00');
INSERT INTO public.snapshots VALUES ('d3fb7048-4cde-4f7d-b781-67a2b1b5711c', 1, 'sha256:894963eefb2fb8938034a84edc07a2b1c8f549d03b74c51e2d2c519da8482f75', '{"$enc": "enc:v2:k1:Et8EwTTCpOBC5CIs:dsMcQjzAHU20UPXJGKb1L9Guf6uDB-2LureKQvo0xapm7ljwl6-BT7-ogO0cGVQIZXtChTxWD1S4WcIbx8BV2RWoikiadnJ5Xp7aG93Cbrdc2IgkDaAqK9nK5gSL-Q4Oa6swnNVXSFAEIp73-XaEpQpKR5uZQchFGIzQa_Mc-Ya4ZqY3RPElg8ls6OCQCQaEUmorIR5h7vmVZFA5GaUB4K_6hoINBhC-kPxNfvc7Ys-oW_RlTSrIKxyT1Er8utbJ7mPKfbJfk4P1gc98cDLotfQlbV0E3VYEKyx8U9mgtL5hyseFNNb5SsrzyOJTMRk8ohnyk-7o-kYLsPI8HsxTULYy-nHnUotwcHhS2CwPKBC-Q5bwVyYbqbmllAvCy4HoH9QD9XSE4YebW7M2tCtHSzYhomJbWKDuOhfl7wBMTMygiXktn9kJepCNlBIbO0Dpru-qmVfFL0UuhGAXpBSFmmb0prPr5R-pkh920J05FRxmKv1g3LKeG0bXw1uUarzG0-WCqJSL0sXnPaX-Qk9EZDwNAEs_p3TVxLFifb6OB_NNKNms_eXMKReAGJGWvTgA1vTd7vLUD77HRImCxocpu4cZQcxZx7YQoUYfS_LU7CQ5yBWQwyhFCr7voJSOUOFITnSHCWBKPoL7Vbu9JIqQg7pIE90zYWiKwnr0dXXJ20RzdiDrNm9KnB_irEWDyVYKtpRAoMwyK-nyX_-MIMOcQvgknUKhihaPKhqORlv9Iqctb4JjqrF7TFS0mTwlmmdIjmxazscNQjK-W6Q5KxsszAORwmDJkAZOqR7xlDWYENnLKbBMbtC3JbQ9lB1adbZ_QwZIY6iEIRTCjXjzBVey3LqTV-nmBVcFGMq52OFMtsmMsdZYo_SWvX3ox1sZPUBq_KX1BOxeLkf5HVt7ixXO9NJGGyACKmu5h-KPqPWwvd4HIIOVqoaVqYhgMTRQEY7SnAGQRFRxnZBq-iOS7JUH73vxQaAi1NARZVIgmOF5BBAoLHQiyuyyDJmN52sGpx0GyU47gULizVnj39Qag1GelhcW4ZUgB29ZIAe-AczixJqoYDUUNpBYPVgk6Vj5acIxdKRy7oVkd7Wc1Ab_5j79Xqz4y5x_1JsFbNWfcnYgVxXox6EuhbdDtSV9vXkuGFqd7t3dq7FOkpV2noyGkY2jB7krYI6cDhkK4fiEbYLyByVstVlw7Vwl_et9y1FBkCnL1DRYlgTOrzacGW3VscVifwpP4FIJFbOl5v1ddehfMLY1h0z7tX3OKLOnL5T2QYPQIOClvEJm_eKCVj4DHZUzcWSDcRbA6jbvUmASn16whwEUahY0EhofB2jUuSW1VhCZi6ASlwO-mjH5wd2s4BPyzc2dhrylIM9AYyku9lEECBqtpMAtePftMc2_WSKdqb0VgaAzt6-ZDj26W1JEz2eZ-STqmj5lGg2tUno7SoOnCLgACmegYBEIB7MiMYJV8MwzN-7DsIAph_Nkdki5D9Kszm3UQai7a4Vh2jlbrDghRfnDLBrCBnuf_Nd5B_SCVz4gMmk0Zqouh4POjwl2aLkUgPLsHaulLyCeRXJA7cs0f19HLOgzRUnfk6A0EdFxyyyeaZM0Eggc_WHe7mXxrfSVb_iUDqp4HJn7SQ0ykbQQDDK3VC0iLNHDT3kp--NqysXSmBdNTf42KaEM1f-n-hQStPfxEFyQ_D4z95jv2zxDsZun-lVYnyGn-rRtt5H4YU-ghTvTzWq5DkbBLctw0cXg8QqQXdQPX4J3YHMEIxuRbOvIhGhNXLzfHFwmA-o86PJx8snz79oKaRJSg4p06C2P0Oyxx6qaE7enFbgs08BxPLqiktK7TR9mG620BU4ubiTKx4MkZ4nkbBhwJibvoqsrJCyZsefUix4XRP5Sf0UOh3JQb_fW4dlydyrHwOVVc0oTH0s3ZKCJnxbLWBTaw-5jk2EdD87KHEF6shrEP2IeKOMT2H_B3vh55rs3uKrAv2geSFGdigtxiZIkxsE2BgpEMXwjWJHjGFQQk_qv8PmyTAnVyNmMhegAYqtMuyKXrfVhU_RlMh-CrwMwvzyO8wesLzvLC1Ah2N_IsXjbvAi71GV4AAwislb8HZicQ8qcIBz9x-wIQDQwrjPcxG3GaHeWmGUWgJd4jxb2qPyrH_H3x0JDVkduTFpFq6DM7hTSkhTOrxEszakpZ7ypqUEdqmg6qXlHURuRwzLd_ngH14XGWWvf6ve1KPXLhW7p6AvKfZiTD-isj5BEV124YSlBESjABcaLDH7htxmNGQx_aRCPQP4pKflx0GdVfKb3cV97M7WeiNrT6zBsnDbwyTJMCw2TIVAPaVr2kMg-RYMo5uTFRH9v2JYQ8urVowARY9w4kJYoOd0TqeMndtl6sLg8c1wfbs2y1mcQCndeKZ1El8uBXIMruKGrTtLZIy_aMsBFB9v74ybAXWUObnnJfcBQGA3VVUhcMMi4bMJdXVH9gcH2w1lJ4eTcMTmeVQT7AOb_aLqzE7N-ox4dhtPT-BGRFbXG52fRojlxihJSlSvFkfhK8AY0dUki4qsnA7OHkd-c8X9bSdO-ct8Bq1atRS5Sqkz2K3Iz4GGYAI6CBafJOPL0EEUI-X-R1X0TD0g1iElX0R8Dc2iB7p4dK3TsPMxsoxn6FUYQHtfbdh-bJ4ZpldWU1Bml9Hd_LbzvX-AFYdI7V6Qt2CZAixcCSC0pEmA3euLHSX1DSO7GSqMSyDpKSv37J4gIJQnHeeL1PDy4Rsp4QxnhPLghfiUGwbb-dYqKxdUqwQqqsA1OYcV04fMtX97lpOnrQ7VETiHp-3_WTZ9N5ff3X-8HHUzaiIlctWi_ueHGR2erXt6WV-ueBIG1cqmbkf2b-stEFUMduiVTZOZTNuRTZa-KuZAZDnJb_zKEGvC6vdxQ8N8cLsNfbK9uNkndtoc5shp-hVY2sXTPVXKPkuDEIUFbC6yqeTQN07RXwns_oAHP92fWzk65uXUjj_D7V2eu1fqPp8zYrRuJ98z6rvThNB_7lWf8zFyUi9J5VbO_1azmpEjFZvgERpIZLlGSi4BV9Tuzc4gP_IC-TqGZEE7Cj-al5zxFEbChjhsWbA5aQaHCjYJM03oe2vPX3z0inTFooQgmf_lpqx3P4W7PwMFjjZYbtdiDlEWux6ICexltQuFgnU_-dii16c03zcLYARCP-QVgyMur3Tc3-4hgEfDbCf5crzG2D-JhyHSxtf8aE9G7uvdjUfTJX1ybraIRTPxUOO4X_JJYBgSxZxjBKQR8rJQMMTCN1h6IWwtxeORaWCb6LAmQxmIJpXAcFRJQHnJIGouhsTH7wnRN34HedHAu9DxXfnMu4plVaqJ4gY_xWmbmf9wovfNjkNeJUHLD2Ra3yZ5Wrw2NAHZLQo5DXzNWsEndS8K9NQxJp56NVEbFsQH6J_j_KOz6ziZlifGher4LT8HO6mTUBilzeVmsKq9OY3qqaTBzQQ0j9QMV5-ouZzybJR780kbEqbJ41f_IuVQQbrOSp1Z3EDFGEV7yZts7Eo6pfB4IF138Nc9XUe3E1iA_yI_npGleZJarGkOd3JzYLx1lFwmPdbJVhrojRI5y-aOkI130YWswVu22KBbVTShAiWlU9EBMF0bAGVLa9BXvoeX5uLK2CGgJqoQI_myIs7nsDhKo2Xb8YTLk_RMTzQ1qc0HfVSl4UPxdQrZ9sN-J4aMV6hPGTrcRifpgCl3WR4PNWBetubIVtgzFzynLL3JWAAGpgupA6BI5j110cBMweoZpdC0DsrqFQFOJ5Cx8n401gfFGojgY3ISNOplgImzvTyGJaG_4M1-bIaVJhCESX49fNqFmQ93RFmaF4yBzOa15kpdHz6ATHijcn8X4Fzm-AZJwF-INaW7VKCYgfQaBmrubbuiEHwdHicl7y9SkheoUr9rHZ_C9ldnyP4h5D7wWdelRnE3hl1su0rMesWN9TDLb0hDifrhyPhSKmvYX0w_4-9hKoXNsPUtny6rf0m4eb9czMAfGzDzeamQR58zpMU-aBL9eB4ATgIWEE319d1lTdwkmpo81F0h1Evbgw2w9sOUR3oyzRAlirDG_fRFTWp-DsNhHbqZWus_7giG7gvJLNAbx7a2uj2kWphGqkF3b1_kocDIYBqlyH-h5z3C5FzXwB4-BbMu4NpTonfQywaRPHWqmW3aDjkEoI9TeBiNgfLmGH6_vK_soz_7UhTzeoouSadqZj37uCaXRAA78_s876ad8Yyw_DIijBH6IYm-61CLxoJCQDCzUtVt4qbctCEt_3bVUwQjWxdRNMm6ocbz3zSGP7ZtEYOJ2IbIgYnBLkFsndvZBQCOAdXrJUO44OknOHfCnmIYG6zwxlO6q24C8qOewI2ZxNfB_Efwhlp313s58qZl6rwHA2nGpji-nUvNEe9B2o26_M3OGaf5fNJ_QCQYRf2VbDJpOoBFaskorAFmd_YxU-dCN2YSbeBTVAUtivxw8g2kf2P_DfK5k5bCKl2hRqM1Gi6n6aNT-zj-AsqH6ls31BJt232u7AmhG6zLO-Wn4pm1SXVL9PNuWiqrQGUJuSUHx55GWzUfVXiPgUDjszG-k-o_zWXYd6z-2X_jK6e71wcsGBwb1Gb3HXN8BP1I5fJ-_r7WZPaEWoa2XtAqcrKjS6Vm-T1W9p8kyv1ZVQoaXbSrBuW4Fx-7X_ctUhYG0QfuAi-RN4IcvAe05hHhq5FoAd2u-DdkW_fezVxWZ4gH4BOE6DxyHNPhLphb3iNsL1vjRqjvbpNnSV-ul49XAoVqs11GsSPP7pStKHZcDErX5KmGkHb1CtvP-_AkAuIWpZjm7V8TOWRshaurQ8F_qoigEnkYaMNS4SIOnh3YB8rBTTjBVx4oiaLKysPFMdFRMsBO3d6m696pygEFhFEVAQsfSiJSIk0z-7Z_m-1Ee1V_--g9EidGdbjC5Mlaid7wwm_syz_mknSkhD0BxAIRIaKCx7xbXGwm_aP6khAjlFXCFGxna3P-Fr8dOh0y6UOZKEeh0Kblaklu87HP3MemgWN1fKCnXML6DwBKw1FiSEnSchr6_tRJkqw6QNfNIKhfzPVTTA01pTZ08QQlBvZdqkSDCA-LwldYa7i4bbNOJu-NeCnupYs1eWDcx-BnM_ZFV_JZ0yMfD-KXti6FAb9Ld2UOsaKKOIkMnADImZiP2bzaF4dyGvjdQfGmVBDuiWblzbjNq6u4W9w1TniwYgqCyiBI_uZDJfe1QfPvRhThfyXLaWcqrDysmgiOYT2E6Kd8hIImLQ9BSHBPThY5Akcx13oDCOmHaw1AFbEOfG6LSHJeNnUY8wtw1H4KYMnF_WPObytZ3D7o_JD7-BZYazRf25xsv5zjjkBXBV1zby5RrlPtszyDBT8QuUz8kUXAkG-FaPwB2M3ckG6bT16N9OHxCaDFGEkD6o31sOWgLYjBzZcwyNG2HfD7lKNdy09OfVumtuyvwHG9NVhsJYDldA5UftGfbpOjWyuD03bKHW6swrMOp9puya-SfVOdek4AJY4VGrMLpmEi_CwCr2VeSvEb8pzpM_N8S7SzxFdlXVx8Oal9zNBxitU33I-3xzxLBHJqrJO6jf9uZkm0sBNPVXdK2qPO1Y2uPnSvQSYT9mHJMBfJyjpkSWW-5UFaRDCExKetg-DY89Gx4UjQ-oPicjxOQfZwlKDaUQ6VUOtzUGCBnf5z3-kg19EY2LuNIzNcFyWb5TQfMNtGvB35Lg7sYuAytfrJAWB4qcFbd_NE7phPNoVU7xa9irK4Na9Gqb0s7JNiXXhxN5er15_pV_BcEKClJJudQQWVP8hr3zxBwqlMnPAxY5xaQYQywKrC6Ibn9bHskrac6XWySkGUonkbz1tSm4sc6dCtJrHspfjME1nHzi7VQjz_synMJw51FawlGIseoMdlc_YF4UiTYwELbaq7NtWl41mvbJ1AhQEcMb7Or6ZDP8e6dEyRhAWSaihq-5DeK2A3dC3hOnF7LEveNSVqinduqiqe_fdRFqoBG1OnzM9o_65f7spgiXu28yL-ksqXeHZBdaWbGv3Of8hX9kzrWscTUmsUIK4uXKmL7Y-cjOIKde009Ebq2Cx79oXO5XrAsx9Nyqp0IuLrjb4Rsl9K8jTpt74dQxWV6Kwe9MAO-9laM61goCuzcI5VfRNAyrBtZoOSSDmV9v_Y3eiA9leWhzvNg4a4NhFOMam2P48Y2pSi7nczY2VTXmVmjTKImy5FmGxAgF3HX8Pcqhzg14JpPB8ME5HA3_dd_EewFc1Pj-BDn08aeHWlzPjqHDfe8MqRmp_fit-fFqrCiW0o03zGxmtZX:DBG6U-xKVCBZWmdhIKh4Ow"}', '{"$enc": "enc:v2:k1:33iq387zZPOSUo-q:J5lFIew3ntMEa0FK0bARnSifbQ3yIHPTSUthybHBtXTtWR02QA7Ozlq-m1tFUZOiKTAZp7sVGLjL0hm9C7qHSG-PWDKulsi_fTtN4tCxD7jVyu7yO1qp4W-ZIiMm_MY61dfopYz7CnBLaGkSqlvdd3N6hZSFxFNJkF_fPV1nY3AThJ5QajZDqE2JpJlZJZCMY9YBWmSrpdh4UIC05OxuZbE7wvwyJTnFi9_GZETlEzlmE5CCD662Kcbhb5QCH7lKdtIxUPm59pgOHgrnTHk2T42YCLpg4Y4zq4outxe67CwOwS_hTUeJP7csfxr_oejG_a8ycCYHNT401HeNH-FsGaRWu0IjTtl1ZQp_1yXeEBoKaMJvmsMaTByMzMQiFNM3-f_Ax0yr5Faw9d-c7coVGR9cj0CpvRE48JCT6jbpb9DJ7Zx2rrNPyoV4_dTJYmLNOy0Tl1RbxEvV4uZ215P8VxvXSA0CGzqqGSVAXOxRfrWyky3h73ynPNr2NNODlHkkCH4vmhrIZ6UlYC5d0xdp5kCVRDpOZ4nfCOM9cR85bM0XTRmcGOaQaFBIXzrs16YDlGM3mBrXiB8NQGHSkkdTzF7VXrtuykC8Duq1UvzD8vO4X_ztfhhlbJQbvJNIHQVhzTXVasGQXyH5BOc5tQxbS2KaYvlx-OYas1EgOIs_ZOFtIrPDcUwOKtGmlmR8ratjKgFNo1tkNekdGEZSXvxxIGje6vR53TslffDvY_fd8kAA_lyhFG80jUK3utU7GRb3aBPXarB8wRlmrd2DriWTmKsJ4w_o-5iOfMihkMDoJGdW4d077B18iQyeZJjXxpMWeF4IPwbkT2MXIlLMSiILO3STifXnj0G7F2VWGi7bQwDZeuDcY4SylBUtPkUoTmSSNHAJjOweW4BvdwD7BWY9P7DV7sB9sOuknh0fembbOpNXRyuGqaHmuuSclWob52Cu0CZM2Y9qjVA4KWbuMZ5J0OVCL6aXEr2shpXAbz8MOTCzTS3diMGb7q65fk0v_EefiAufhk1_GDHRny9THH-rCRZd477vT_7xOtCEohv-QlPM0cObIn6MEYecOJv8R6mmJiP2hX1J0mgAMAJ0ZzIxUN3i54jMrnXSDWCN7fS1cZ8Hu-LAkVDddNhANJ3dvTEj8sBminfVehnR6nOIavy5XDAYmaLAD7ec36wtpD4MrAJr_fPAsydJppcNmGlsEe4SuCEDLUzGmw1TOyMZZETY4-MWxs2qG4fnnV979-Wxlmop-sVIrBMAOEvTotkPVtRF-aiBNcBgjgtubLTsiF27RT51h_AxjwmHzf10idO4OPIxhm6j4PxkPtkt3I63vf-L4sN1vCoJ6LatNZe4iUSg8bOnMvgi6CRI3MPgE5iDgmj2XSOGJOzOLmhfAJrbA4MVtb0sucH6hyuQngDhGI15LwJVsaZ6dtnAPtQTn--N-87f0xX4HFndoJMfvhofFuH6o0TELV3sdsc76RcT5RBv28e9vj7W6K9voyUM0_xZLB7EbqCbNUX52aE1SWZ_lKo3yK_j6XMiP-NIDH6sGGfvHH10b9U7Yu5PHo84HZS598P9ZMPizkxRPUMOZhQGDvi2WUgPT4dupdxaaWaIZlAQG7I_b57v7-4e1Hs8c6tqHMFJopNvnjDMBOEvEcodUSUhPw7VZV7DHpaV1vQmegMY86u9KQooQqBGYVgYS_0cGdTKqcVY6Y-W6MdAWd2o5prhsYE7sDU-Y4vAT_6_ezHRbJotRhk3xjDCa3nDc0lCK-_B-Q98lh3PZqdFP37NRgpQw4C96OoPi1b0v38LWjkoWrJ2VtaZOS2ejYb-c_5PoPmjkxXfjaVZl95ZPFQQvSBCfxMoIu-ikPVTWOJd0VbCdueNykJ2WakMFt8rVXqgP7vnA_Rc8-H3DzKhtvHHxBgSCE9XSnnFDg53rnRP5P-ju7D4d-tktKapSYJqA6tES5yC4xjlhWP-wEGxywL0LRVw_npnFzyo9zb5yclbXyHSzkyVy72tLvRF9LEqRp6yvuxn80ecPg9bVF6Z4nx_JAcjeBZ4ZZksRZ-GdVlbR3dEuN1F2F9scKxvSgGWSoDL0KiQO1-iTQzU74Cj_n6aHP2Vh_d2HfVNzsNrQRqA42pkS7IsBf2D_Ke0-qKVFPpguaB2Zh88yjOa2TepSOYIAaCdY55swk57SwF286CCBXjVHgHYOOKrxXit9ybZRjkpmYyfOD57m6IfvoFnUZ1z9zYvLFwxfSqMgyWMLX2PRhp0vvhW6qrGmRFcAUazlPqV13_vh6xyeWjuUSEoxragYar82_vWO_tlxCyPkwlHxk1TGmQO-M5IY9LLb2s0YawoNagAECO0uXJhZsBoUct5EoUMjsCPD3uiPbCVxu2teJnOvmjSSZVpduaG0LfOAQBicu1_8WrSEIWmmgL0DFqWTNBb-MZvYNBkV0By08ME4957CADdd-PiA4cF3ZiJdGiuqyOZlxE52ZW5NG7D1v0ulDdO5BsNaXPAAt13odBIEEpiSBDMFCPVUMGJgBYe0OQIPvzAnTQOTzG4YKmX32fQhjqVMtYZ4EjUBHrO4XJF1zh2l_4hAyIYqmjujO4cfOiED50YWWb5kdk0_dp69sHw-hmid7Q6u85S0fNmDsdiZcPjhhTEG9r90zRuQJ4MVSO491pTCHJRU2U95cgl-_Y70r3QmDRy7CVYOM_fbXFME9a3PYVANF68BfB7GUiaNtXk-fKgnrEtSjoRkTurf7rLVHKHzb60gDkS1G4QnAifGLbo_qRO6Hh9CImeD569EyvE_V9NO8winwn-Md-04LQjBTx46M2ntM4-nEscpqtJWJw5TrJ948GinBvqEYKlz4kCY-WUkQEFhAYhSFZn_YHf0MAy926ZHqs6I5VctM3VYHbmaxOOq3n8HNEvDWvAXx0JkcK0goSCk9Y7ZmwkHGK-i6KngUixRPRB5MPxNklh3VtRtKulQOETT3cavrcM2Cdcogs8_7L_MtWw0tSeXsPK_GMvPQ2AXmDg3otzRzd5nzUXy2yN9QMUEF6rxm6B1BmzuCqqcKsVGm7xeIMr7vlKXg_ZhPXXJeekOE1myc1S2xxfjCpG0roGTJAeSeyI8UWROx_m357jStvcHeU3xFpRqw_v_aTlLS_vW_tl1IqX7hGy5i0D0DaaSXrWa7WeD3EaqbascnvQo7OBJhF30kIfXSrfwH4aGgZyiWXTLABAJuUGUTo7NSYS6JzOkG1W9Xc-7JXF-7R96jjIuvtmK-W-6Vdsat8LogccSxtffKi1rrdvdKm66hAKEVoEHz9CsGMzVBjVF6j2e_uOrJ_1dliyJI1pqnYTSIbruvJ7xaa46coWo7dRHEhxI1Af6DkgyL8xp-agdD6igrQKo6ZwhFi_es4fua_WYoYyLLiBwu6wlEq2RSd5_W_uRG_6ycu25vg7lxulTlhpdmbJMzwfC7VDWncGnZRwS_W8yXoDh3lx4ie07aa3G2aGfKL8HSPj1LsetQESfd9y6SaTskJqRdHO56LGLrD1iv8R2VO9tMZWEXg2wuASYl6I68MXTq2fzSmCypmY4iMs4b1MMdaCNa5m9QzyMcQsEqibEhot3EnC6uQuJK6djAZ8jEMZwPW7abRdWapVk_Otq_KQSUTdaVM4JhBxV5AoLKYf8bx0AoM7rbpBe0qKou6mJQnlGCuDnHMrdIcGGtX-CmYZ8k65iP1dikC3rLp51bPAMGgs88vAo8yq6NZM7wsWfj73v1W6srr19Kynnm5RhUl2j4XwcsubBPaNqbEwr0As77IgUA4cSkqbfbmw5FNE8ByCMjrHZSEIkX5elHFCBx-LSU-jvpHc-vHLoL1qgjGX6tmI0aUM_4U2IMwERor9LuYRM9xbsD3Od6d6OtUhIDvhZnJLfidI55DwAl1k2BwbTnIe6LiQF7KuXEeChEmAP0yCLeYiy4dVxbG2XK9w0GUMuqZrz2ZEwo1YAFq_UESEY8ueIVtMjZHr_CBz8ELUniHXci4YSOir_bDFJo5P33zPoEh3eDgI6k9T2KFxNYlhj_kuDpWaAdPtobS7q880kizzDKCbICUYQJKDy8rbzsWxkPKGPO98FRwJBlulJoZb_toCtZGe8BcEVvg1VZ17sl4m1O107f68gRKi35RJyNWRHGMO5DibhNQnx73hXFWcA5kFfmFzV-NjZR2OYPlcqBDEl6VbLd9qLrdyIBCXJemxLwHrpL8xfqJLTmMEddCYRpmsVWRIvYE5z42bmBqhIrtLejurZUJ9hsYiV-ZNKVUGSyij9qCbMkc8s3DHrGYpt_paOJ7hjY8bvpXi9ZtulWfKzbuqqFC0ccWSy6TJ5FEUNDixEpKCaGuvFYy5VxoWd0Lu3iXJWhOZWDKSXWyEAfTMeMSWnQRecPUfLz1fnsxz1PvJ3tRIoFGnIaY1PHR_RDdqANHSnYncwlyKjHF0Ha1Zrdnmlv6lFJ54rl8tfKk_uo9s79Zfb_HIiRgcPoF4HeJ-H-IvvJel-hksT4zxgmOxWIuA373AXrqCas-ZTunj1SR1FV1h_L7R_4ptRD1odo7p1yOXS-IC801ZZ4Hu3ZxbZv2EghWBhbx5dDryOTGYaloGd_yDdDYCC13gFGPM064gf6mAdY4pSNX69uPA5Rs1DPu9D_kWTJiPuT4tufpOO18trWHlIqs_cgLFkd-gg9-4ljy_cg9bL0dq5mCimvDrVXhx_7QAG78BHX2cAUv4ew_gxHUKSu5CrFdD7UV2cgdsrjeYWEuLv6FWyJX1jEx3aAKGD-lIWcsIekX8wsbcgSys76w2J7kLc66NnaiiBwaIhlT1y6Cu0gbNiuS4UgdQgNfDEYqV31aHvCDfX850o7lKWEnVVV9AG1cFL5s34sqatZAwSJtmp5wViRMAyVcFP52SAqYc4NK0IZza-mqUwvAl8yzOXhXI9hznBfWeTwYnYMXbG5rojQItWcKFjsA0iCUIhu3pkig2rEcatUoqthcO2AqA5FtmhQrznMxPMEbewdP2JGUWGGCce_no8ep680AQaTie1g8adev7Cjfz3CtHrpXlfZjvu_hPVtEDGS94g8btg0L6zw9fnyPECTT0AkIrFpw4rnKhoOGBjAUab9HUpFb9o--_jgi7DnORRqVCSqMeRF2r65xgJmu2ikmoGznMFPKXok49JLFp81mn_CnYtpmNR9161q0-OnuiTfXNraHw5d3Uq9mj4Pt2aKX1OCNgVWYl8YYDsjfbtSS9K-RAcv4oB2lSn3dwXVFHiM-4BWkBc0Sa4T6Hswinve5ajCb2xoLSelOq40flIxTAUbYdSME2zVtEJVGaUQZ42CYJWJ7UoRPANGUJZipqr2QvB7VVaYaBB3JLBnDuyuNTvK-7w1KoTx6XLzZhUHO0UjUwBupbWpGhpzrfYeKUzhxmdjfNyk5st4Svm8x0thYfNQYf7iU2pnd-AZIhjObxjsN_RMH1EO3z_BOjRJwAuA8MsPTLSYzy3SWYnXmoBeXOqcXMNxVhSXcFB25uwleP3HIaoDx4ujSHj-qHTdunUdBBpmg1wT5MnAJEpwchbCOJY4AiLQbvvzT5Lo4LM6Nh9wPT2KoDCK-8IMUp5CrjHPbVVSXp_jEum2Qf9HsOHzO_O7-v1KxKn9uxUt_3Vt-7-NHuPe1CaUp-sQPL02LJMYkqCJRnI8BAdA:tktQAEcQqrt2vfhjRJVmKQ"}', 'first', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', NULL, '2026-10-25 17:34:16.409+00');
INSERT INTO public.snapshots VALUES ('d3fb7048-4cde-4f7d-b781-67a2b1b5711c', 2, 'sha256:ffb50d60aa8f5630df4603f9495f00cc4f8e9c1ed047527fec4b264e0c7cd01c', '{"$enc": "enc:v2:k1:n5OoNDksX_J41Xem:Xln9rPCpTVWrxFJg22b7pWc3Hbwu-M4QvXGqN-TrofqDBhZ1vnqNNW1frOzRRYFISY6GU6C_imhNya7uLy33T-RGmq4c-L-4AKSTR9Gs-59IxTleX9iXx9qhSwiLHmXtr58iMHC7ZWAsOGvxzx12qpp6doKnW1RBJO7Cr51DXD_zbSVexHm2MPY-x-90r5HrYA86e1T3mlOoFJc3FwB2U-hMuKX3beCdfLDdTn2RUN_eyJ1ogtmTA4GqHSOI56HIMb1iFUG4k3oEe7aOZqomsWZvVvnedikUPwuUSr5gEmL2NgkQKXXf5nA0QS14RRwpCUM76u4wC9Y1C_Z_gDoqtfg2YuDGBq_XABt7qkpMx4h3CEzs4l8ZBWmjdXsnTDA4snxQifecHzrhq8-ZaaB2sM2tmVLXXLg0mEH-KJXC-fhLuQE-X_erCRES3e-ebz3yfLYUTbeFipNVUXh40EAaqmbzMZw_sWlUTB-CBAM86dPiTb6hYhiR8IDLBgJm7CsGNLgZXZklQ7zQEAu31O639h32vBjhUVITVeWAsDX_vOebdUzRITJqgf80xBUD08AwJDJyl4woS74jbXC-z33o1EkA3efEatjToFsafWeAQCZE-Oa-wP7J-2IQKosXyBon_O7bMvGuNhbzHrhRsnZm-Yqlnx7lVJSd8wRlXrT8Ra8GcqLo7Hn4RcRkeOdvg_dw8_UJ0BbZXMjjwV2FX1KECkERfVAo1zDNo8u3rofZVD1B8UVyaEUTUI7fB7QZX7JWRqTsmCmsH3zTy5g3QQerD_EdmfO6pHxEYtcmkfuzrsay5f9utYIvagBoWhA-fgbYgSlbUvPVlZDie0LRHtnkXBXJvtzzoqDUWAahDAAoN-hnxtqbXJb57fC-8gSWQ9DUk27dFQpgylt4z1ejNNwN3fScrC8yTbIRRc4nDGS2VvuMBMWMBpNy6rH6mB1HhYwm_jkD8ywMCvYmfyNAP44AcpEHTwHuX5iOLyS3EjO5WUBU2W_sbRGREytX48igPx1QA2jkOVuEl8rjErvsL9CvmK4C76W1yasLuhwkicaIwVonmiWWnWfs6e47oBlB1gyLlOPb7-E5q2Hy6F2mfX19Mpg2gckIO9h3Olsq98fhY3bBBGy9Fh8IVe6ZATbUgPDdaT2t75j0Y_XALBpxN2pYSY2YHD5qPk_n4bP-wJH1Iru9RoB-hLgWFVJaNkHU2H-puShlJ87pXalSOxu7N9tVLi3YJj0KFfmLHfjHDA8X5QbNG4q2zwPqgg9KZkdkcUXzVuispYrOFDYxWTJqwYTycmOTNkBdd6ODzfSQ5B3nJG3Twql2svPjmQBpQUS07nQEvheLMouiFX3OwWeXtEsRkntlW998Yb3fJ63m3VVUrQZ4UEhdBRbHr2V8lghWmVfQ8_Mm-6E6pNGYk71bhA_3IiDpoRJ7qMfjeVxrSVBCq6RzR7cihIxP2xYu1daxMVIgG9A_LBPDiAJ7T0rlpxzQp6UiPHZS5YcyW3eWt2clA3nZCAyY2PgF3XRP6dUdNoxaZ3RtynKypUKmqracR0MsxgAxV-wg8kXs4Ke2xtvlmFUPxbZSY66jQNmtMe8IymFpopC39h7UBTI5tzXWihBueI6ZaXl2OGtfzPGqrxPaA0kSBzpJt54nBU8p7JszOAfEybjw8HjnAhfkyoP8rBdD6XWUUHF-o4RK5bMsH0p5nBIaKoXa8Q-fdC2SwxgMRQF-xcln4tvB9ItjDeDLsRfoeCPgdW2mgT5Yj8_SJIN4U8eflpB2WNZDognH83Ktdh8GGQxY3CStx8-sCdDqj9tQPt2I_xkXTCJtgZD1WnLhFSexd1bV15QIwSEZOcTyxyRqHnXpnJYRoC3L-wL_oBhbA4RThdXQydloGy-ITvzFv1iLMFbHFRWvxuRVvy--2MZ91SDGhQ8jPBaRrqHAqKaeNPV9Xcs395TZnlKh9RNgpBTIQ919jgp6V6RI85T3qaUCJtfdwd_BQBo0YiaaZ8fOATDSLrl9quGHaitd-IJuU7oJnLaO23lCUw1ChkmWzzgHIqZ9Cq6BQcVTf7m18-SwJ9Ejy13ZRPDrOqFVVKpYuKYgmmBECt_KNREb5uBGNx-3hO22StMUB4-blUm8g9gKoSy8DwOn6dE9AylxiwZnllBP937MugfgW7SSEfj8I1FpooxEkOQqGHCWVN8xZb4TWwU-NAhb_kJKIlCV0giQbDlBfIm8W7smYFTCbeQxrSM-qdZEKzav38jndYTyiLwHZSniSSVJCn_tdo9s_uS-Lk9Q8_Cmn58DjBYw3bI92GOAztQm_ogC3CpVBpl3tlNBVEZURoWSgVK-1dmnlXXgNUxSx3fJmCucVMRC74T1i3IGCDLc-cnOeBWcIpjeSEkGC3Pvbjr3O3LxsSrkzqQl1t9KZGCpIZIi_PGKaLtePyj3GsJcWgY3-6En_WMYij57pMqK6IMASuQdNKv9ha2rkMzJ5_MhJqagt8UOpfju4cj17r7nhsj_lOMpY7i_NXJNMoHi0UvN7kHKlplH0LwYLInvEsoJ6Iy92XBja2yJG_tdOrQB_YrVv1PPBnjFKeA_v6gYeXloWaspQDtixG8EKGl_-nqrfOgkclxxRrgTEP4Ws2tl2pYQXoJwf8dYKtlpnPEzwcOk1Xoaic-2CLRuyN_pobQK0l6mrjCq-DN6vJ7cnpHMUnK4dYuY7FVl3NkTcWO70A8iVt7aLDC_K5PepRY98bcGsmJiFnngIKhEoiB7h4nzAmRd8Z4qc3ycHAVox-h10SmCi0RgM7YzwygyYjHoSnfMa5cq51iBIcnk6I33_JhfjSCtDhNBDWl-mru8Z_43qsOS9pOZ4enUlhLy2CpVNYP4qbiGh_BO8bJ5oreN3gUFGYiqYF627MvWfytUcdZnKt7L3ceZxnx2wJPLgwe0z0ehnSRv5kbT55ye4Rblug_R0rS07CpJvvF4-USqq_1iF9RY__kVNT6dYESVZ2akRseOntuUooDwsetTcnyQGn7sNkoyIRI_I4H6uV2-8WdC-NvU_CQN_mJNkWHAFSVlz2XzcmTV620lCplso3Zsty2pAXKqJfdkKrtsk9a17RZREdDD9BarjcjF9Qh8NjQ7GUb3xWJ5oqwEVHJt_tMbcW6phdoa6nDZW844cvc4Q3bd5bHZ8JWQOzvlBWV2tZksP-QaU14u5qwpvmsWsuknSKBcMIItPr93ZXdExGHH_P0KPAY1iw2h65SzURsWJ-2XVlsfQYGqFHkAoe2VkCMluEIwecqNmiRxYQ2-B7TnTlLfbPNpreybraPoDKwD78McmCLR8v-oJM2upssbov3gn3E-O44rtSvs78LYmMATCnwL5wCaNPxH-pa4xY1HVdjubjlhVfgFLJ1QFRKbVC1AKTMDhjfwr1BxEm23Rx9ZJI_q-lFvztlrHukkL5tgIfQDN0XVv_J9tCoFaIz0h_1MyM8Mw8j0ZiJgh0bD1IVFDHG1CSZwjt5OmqbP3lvc57yuwyMGdxcoLu9fFxetUjfw2GXegRBZZQYvHURBYkE6J47SzoBdjvf1K5hctIXTMMA6k0E1nGS2LKWaC6FnB5U9_zUq07Yhn0wjAzoxHzrJ7vzN1ByBntS_szkKDN5pdbbEKeGneVg97Kb6XmsSt0VCp5_djB4V3jJMezG-46XXVLs3y7JUrn4kFpHb4Ym3qu5NmFJAUafnEh5vCm4nYfqgu1M1zrHD9Vylg6-dyVbfgkWQmUUd_U4vB6adpCW0rai82g3eU6KxL7OpKgEYDRvzfTrBpUEh3gsIC3pZmlY-t8TFD4dThvT0vX70_8YHneKesSzU9RnJsaE2YQ4TrZiijTDf1AwzpZBqGycMFSyA8jDoXqYiJ29c6KOEj8YsEcVnkOkYU5IpwQ-51k2QzSab4vmDAu0ank5TIFpfjCgggbbEZpbcza1LLvDStKyX3xSXYkyZ06BFywpAZeQ2eO9cafj9467s787hQSIB2xRRlJDBAQjmOPUbKxGb2qsQVbcCm2pbFLyGU4LRqdMi1tnmf8yN2FfI_ypWEiUuwYU9jrnwn4i5cpUNLeEOWNOUn0dEpyBwTqN-5X6UNB6bi5XQ4gQgTGnWXa7mx_GlWy6Zr0q19Yuri3t03JPD5YHoAPUzb_L6GmTXc-GKue8JK-Fr2KBjg0bCNzKcod0ZaDe8gKxdR2ee03k7hMCXa0R5L7M8gQgCh_3mb69Vq9gV7jzsHWodn-ls9HB3iQXfuhaD01td6WxX6NWtp9hchjAOdvWAxumdsYoWvXNYaVPbmBg-ybeX9eH0BDp1qHyYcXHJN-owEvqbTHyq08AY3vOF1_ExviDN_OkWKAHP9xh5nvmUrXeWNxLUmp9AWv3Nq5sZ4WGcXGbgQBGQrh3BMX7-7CGJ75hj0yl0wZjW2KQwjlaoTThVryrE2D1_OG6dLOUjTsS0lUEYDQrRpQ13lNFWY_LLTrXd1RwjneSxEuE_StkV9fDTXZrhav2S8Ym08BQGwi6FRvPobF7EsljcGaiNHiy10ndHsZ5CjAt5ti1gsod0GF5k9qyHxoQ1_PXZ_ZbJiUJrTcyixBI1HbLbPL6kQdzyEwRTTrhsMr1GdClLZ9dvzPvKvo3bwEj87LkWaGegK-nWJ3-G9lpLDcENZ8jNRhHPLInD1y3GJPmQron9ihdMabQK2i5Qcy5L7V_GmOZCgZouoZOfh0Y9dACaLaWupXBR6p9KRKfe89gurYVX66o8TRl-oXOVBxXKoxwEf1t3f8xw_z7MHwEHPa2lXVr8Ol7Tt27fb8Bf_cr3m60TxDj0hfL6_AlljSdHqMSsXtkRFFsABQjHKlY1611AEPRmNWHu_6Kse4RI0FEsfG8Yoj20sKgwu_P90hdYriBiBE0hZ1dx6ymbzfZqDTbxGCdgaAg3iEWbxnvAnahrxRgUoi1Trp1TBJuqi_XKoK86Vy7mr0OndpTd8waBetCqFKh5kDkN6X35z7CT35k6PdRR83pqmNu9IrxdLzE3W156SCJDXz-1xwRLQ3x4w-WbKHAUiYQUHqmdZhPnah3O3t8t-RClAPZKSv5C1V5CjD4fPDKCXO3xcu6zzRzBKmuPe6KhnGPxL5jnOZTJGMwufbY4kQF26sjIo0_7IA2Xr2BayD-_TI-Pn6K8QJIloKo32LXmufEbYNY-EnzHeHAdvBNdGtxRkLKETyPgr3I_F46ReRFMCa-z7Dsfaw6PeOKDcz1qlelnkosWsC_KShJGWA13zS0jLB8IPbIkh-dLuorUv5n-rRkFOJc8UX8gdBPXA6bQqsFcw0mjRYSn1BuRBerB_tIK13hNOQ-1cxMTEYiomdwpEwFZ5HjaQvrIw4qFaWUNOGS7-mBnYrMPP3HGGATKh91EpjVGo5XS5aS9zGM9c21nw28Hiu9ixmM9uM_pNYc31sOh6a5eSyuze2RQSppn711RdT3wpIOLlUfHfVySkl2VBC_B9b9nC7aNMomOWrZCMG3EMo80pw00TyU-ysqFkVOJ4a72nxMHptNAnUKH4x7K9vilslxPovSHW-Ky-z1E9bNuH_1ZMa3D8-L0H_ssmBBljfAgBGhRUxrEEbxFgwNE5bmGhGdRdU8myKkX_F2Nfc81DrYFl3xcNPwibKEFmZPro7kFH_uW4kiBgtJWvltiw56U3EOLiFhxyxwZL19WIDEVy8Uis2wTAJBrHWSnx2CDU64IC3itTBnXr3q-FK_EWIVtnrkrBaJPgRqIqjitkP6ICMA4dzs9bN0M5w93CVreQLWPQQDsyhhGIEUlP82To2QU75c4tZhU_85Cl65ZeLL4K-FY_zEBKMNd2tEPTsMbIdNBqcjKN-Dty5aGJdyP-P3dkbXXcvBKk0u-aKQzFJPr9D_eWgRyUpiEPx8yyWpUJp6LrL1hA-xlxJPK1NQc_C-8vo5KcesWEAeMh07LEKH1ylGen6lSr3bY_Cb2IpUwpEXNk792zcRuBeEjdI9abdhiFbSWzVXBcRLloWBw21TiM_C4sKliJafXhGF-2nbk-itDeG7y3rtmSGuAWqrnBhkxEs3r6f16ie6_RgCoFMBhjtxnrS2TKFWMDuX1nOG3QL6dBjySp8Dd6CdACO-3xWflls8L_3LUfqgfAt16mIaLeQBCgB3pwz6AWEsJAHOGXzxOTQcQiD2JSMA2WJhucrk6x4A4rwEnPMCtS_4qKOgDiByMhXtVNeviHPgbW-lwqs6CnNpodIRWiMdpAqCDAd6Nr2Unje3FfBO9y8VwZe3wEgrZjayqLVFQAoWCAiAmDIxFrrRm3Uf1O5ajrtJgsB4It4kgDAv0CmU_a15rPzPXtIK-ENfko5kifNkNbwygoT3gbvKPYp8USl3XHWYkOLa3FdxIaU6hiv-qfHjO68ougdN0rLtxy7mplklk19T9I9IcBIOJcwjE0NI5lI_rnE4WRTHMOyU4pt7C30_i0bsnW0DRi8CTm0su5oXKm0RI2apu9UR_53J9etK-1BY4ohDOTzsIfkElvP18hK-G1lqzaYecitP2K_ea4dBVvZR0cS6cDbAcNK699gRfZhesT4gikenFFp-B8pefxMUTmJk9oyJO4xJQHoJfpJt4ZCV6cuLuNIclNGlrV0Pk:UmeGVyGQJq4CGhd7tMFXQw"}', '{"$enc": "enc:v2:k1:WANr-EKVckEQC4nP:xYAwpn1h2l00ofm_FFiMA0MBIz2Uuzu0uXntxQoOauNXHYwOoj364D58PfZdywfFAKaj8a_XknPVneT-E2wbpVjO3rcOGrFEWOXBcxdeTzDEX4enGJ0temoTMfIbx7A3WUd4PmrdZhCNh2JkP0wbzkrzSGqWrGfib3yQl-Dt_XKFKL44OOFU0tbPuyFfwtbzjh0eBCKOLae13JvAq32ShiojStG0I-FxQBWSAyGjoVmlW1qeDUHcC4b9vHCIT8-DFCBQfvX0FffwUn0Rq8s8kPBT22RBy3styAi0JWb0rKkcMBNHCQHZATo5LQAgeeG0efflF_DddlBC75rnkWPAmqTfQrTM-ry_pIpXtc_A6ngMUYVELP82L6yU9MHrzhGIoCP5P30UQN6b_vG92r5-9BvF85ps5K7t2YSAlutd7YXa_qMgcJlw-TV5KH37HoJFib9J9HNzer2z3mh7xEvHWFMQl2cCXqK_EDAZPweOgAPdgQeEVzxaeP8Cpx05IBglp0O2GVty6UG0BvQdPBoOiEuSSG13zpkEpZZtVNfjL_FLo0Q68ygGrrTTA4NftytSC9O0P8xoT6xRxOyF1WYAvH8HskTs09H5DjvvJSbni4YbKU0o2r8GUhcxuHHbWD7EuJxm9UWns1KjZQeCSIgetvhgAIIJXyIqcbbJtIv0jh-UvfseKXK7zwsmUPN5V4Z3HFomNGJWPHNOxPmsD6Nsg0VQVIA6Q9pN9FZTFAUWx-5dg-LYOmO2vHQgQeFvFPdH_4yQvsH5LYH0aMxPzNQFvS0YVOuax50S8gv2BYAqOwBQ_xt2_uXKny9PPVxU6Tbxzgf6M1e9QtSNxUWGTAIM6XSCnRO2OdNE_G-ZaS24IZ2dmwl3r0ib-ZZyvNsoLpHiYubXEQf7dtqNMNSc9V6nuea0cNufAiHcYAQ8CHJlfs8319o5xZo5-AoVSg2kgRi1ZrXQ8i8noENx_nm2wtjskT1exVVWWzk6N8sDD1xfuwbGwRxQXyWfdl0cHpaWaictljl5r3pzlMRS0Iw6z-9EmsYtuKtmoZg_KJU-SXypxZCoB7l2tCgBgA4w1k_9gBpahs3ma3fE0xDBrDjg9uXrtFBntM8I5YMfZ7lmnZTNThqgrl-6GloUBuLTP_0XXnmbY3dMyJa0aj65e5hasfnMjeIqvB3watUP-o-IY5-12AgCJex_WqE5GgKfghMZr-CaWBv7NWJQjgJPZ-YHX2wvryV_31q4QICpisAih3n7xXHVIoaLq0tT-Qfl_p5HjIO1ARGlKin5BHuWoWCIh4-3bJD84govmOUst_h-poiI26y_u2ZVJd0SbV48aFwRg4_ITEQUBRuhZlPcI0kX_2GonqWWlnP6xMN3iJsX1-BFDyjawNANFLhJqbUr1UoicxCFNK-zBJqjIMT5fxAodZN_dhRCcPQ_k_p2E13V7w2YP8pudWxkxe__Cps6Xd0xru5eAspvqPG_CHCMoqqOSaaBlj1p_PkUjJVxjtpuLtJchy2eHKzp4IRAJt9iCbOqEUCiYO2Kg8x_m2H98tvvird2ogwhxpYXdHlJU8l-RgIBgZ74lqVfVwRLNrlv0U-5MjBrgpMbDOPswnvJ3f_UXxmX_VFUVlyWiv8CZAZzz7GanNiVCz5K68D2lcpD9TXcgb7fFN-Up-bia91MemdYb4PaSQ5iKuyIC7urGa6kq_X1NQORjfGuWEaWBuYka4l3eNZmHTHz-u4aohILsechAxMWurU1MfK7Z7hLfaytvoo4v6PVj6b03zU3mv-vtA1Hwjitm4iwc1ms1XOQlwzCcMtIalyzAHg9KV69R4v47cQ8195URDE-1Yu0235LHozKlVORvuCU8iTxYHFq5dEKx4lJrxKKiInqf6MfJceeDLX0HvcDeTQtSDCZsBCSxHiY7bEMEm3rAKPiPM_w0myLNi3pitsyWqZJca8coNFPpKrJpDViqc1ICSBG9EGC_4UeMWMrrArYE0vEMMpa8ztiUay-TI_Qwp_AG3KPE-dGRqSlk-AF77QEtqfHmUSl6RvKTlE021nncngyaVOdmtHKHOF8suzgmb39qG1eIzqEtR_kFMbhRkY4X7Ox00MhjsQMyep-U13YgCynWYO2f3j0ph5Wx8HiNDc2QNOU9j4LakxuVIS_nV3T9XYzF0L36liCEBUVgSXaszJU-ODfPQPsn8zLCcJwUU4rbpediWRt3xQgJdIS80-ek3Fecgc6lcXDAyMaQdy4U8_3FfWzwxbKhn9HP7zDsbmM1MzD6mNVIUzazO-2w-cw0ZnP2YxfiGGr7jrrcilfbZGfGozNhW9vfUUyOy3anOcTveuWDevAm-CNb5hmyepQ86ytGGkgobRgcAjW09g010fdIiAABMCNua1ISZgfStT_V1vQkzjd4e3gIo8RbD2Kw26z2WYLhpbtiUpp01IarVuLOVKqqzEIU9MOUnTtr_lmZO75c2RiaTZiU5zrYx7F4N42sIziO4XOgVImZPw2kwSFlmYmF3Xx-FpjwRZNmq9MFvpNwRitNCu8TsGDShcvCdfKcYv37lqBhrHzESdy-6ZfACmg1c_q4nrXL4_e0_2qEfYu3q5cznhIvRMuBu93vPHTyWvTMy1nem3mwmcjk1WiYvOG0ekf1zpvXEyHw6GeyXi3omcAUA9z2lBLFjkbgckFa6-AOmRp9fyRFvSLC3fyFH5mVs2vszNk37SeN22uh86jCRo5HMbAG9CUsHUQDEsstxoaJVLJQjnIg0aiRimjltBTAc45V1XQXPmEsDa36yqR-KbyOuy2zDdkf9UCooZM40cg0fSTMLUQ1_gSZBrUHgI2KcUbbSWWkxlTnDSour3M6jPYvzuhJmlEYsdbH5_BZ5muOfYNOsjcj5koSFOvaP6rdJ2cQQV4_K77oCHGfxoaMd3e_mT7WI8OFV15YfltwwF_UHrG4wERlmASl2SSbhNmZUHNt6ehdfFhl3tqWy6SOO_A0EnBOcYVQ_G-PcgtXosY2sOgoEMZ0MQ88k4D4zjNlb8aaFpDJ6J6uiF63UsAGOCOocZdZuXKjnS1YuxdgUJaKjkOX6aqO6vVAx4Rk2Ks_6K3bgCTwsk492NNqUaOGmP98fpUzosd5sbjuUJYkXNO3CvRPYkZIQIe7i9yJiFxLI_-LNWCneiIlJGNOhEFde3PBpU7UqtuFdHBHEz7irm3QZZ-ALv6K1h2Bhcih4pLnskZYJrQ_KhBBNRmVamZD4qUtJ-hsSSvHOEf6DhQmi09UF2Eop-cFG4bftDH0RilQkqCCvwedGbThgkkIbvbhXYkd_FeFaB1a8VODvLjOLrlSijAOGvc9jpvgsMd86xcaiRWdN0gbgluoAXIas9kJYSnFNx9LscCUKLB-zkbb0gjRWqVf_nb_47ITdQg0NiMNwIW2C1MlfCStL3b-mch_LNnE0Yje3375ic2o87L7vKLe5rIQbkOgz34f00Zgp-jHxC1JMYvn2nQwjqHBq2riBg9P0zKWRaYnnt3JKxC0ALXSu1ZS6I7_Rw1KxddT5PQOYYnxNzgUkKB2svKPvKqeSwlftQcr_Om970r7hJHsZpxqDDnpxK1KI3wSKOtGq5dtees3AfrOTW-8ziF0ZaQwIjdL8YShmCKLVSSR2TNJ5o5U2LsE_nqdof0OjAD_-jQ65lOa-Dla3qhQHA7ttgrg-R3TBtal75xO-Nhgr4asQ499sPgCJGbJpYQjQLCl2Twe8hxL996nMp0xEty0pgV5J0lHd58VwgAg9O62jrRNTubFAV_hOpwJh9nGCpRSJERRLnJDlNduh4bch3JBIADMhW6J8aMU1DWerD3DC2mWD5C0QcGHCkalH1WcU0Jnt1CCUwBjI7feZ-xasWADtwCjv1BVZX5JZDcMwGTlxFAwpTchdkdUYbIjWSwcVsYZwiDU7B6SK536mAT3gPeYKVpoCSRYE8kPQeGJES-beCDS1eb3iue7zriHeO-1jBvewYctXe-RbkWgFrspeUQ8Z-_F2P_4Xg5iWRKoVGJuq336y8NNfy3_pPM6qLSJEOEisdChPXyK64Wls4LhPIcsw2Ik17WurRp7EH2inJ3AZ1utfJ7yqBaBE01ul4g6i6jM2EjeVcem3E_VylnjshC1tr4VJ-UbyP5RUzArfAboHNZPtKqtIX4OTxMPSNmlwJfSF6dAS5ad0LVvs_5r7NWTnPM1-a5-CTK9c3bMz-DgFIsgrxPZEqEZz2y0sUS__5Q599zPUXPbjODs9dOufDxNHgP-VgCpELGQwnkk5iKE51O3OBmJMgxjhT1_AEPx_JGcx2Q8Ts6TLz69eCeZO41-eP6oKkdg4DYTv3lwcRbvIJsZ48ylg4J75-JiN0dI2lAMi6q1KUZeorlNoeQ0G6vL1FkV3LU1wlGVROOrqKcfOmANVayhNx3sC_ZS3bPpJHlJNTqj9xd_My50RlV0ueTOshXe2nmZ57kpP8iyrH2j6IgdPLcrM54kMc-_7-92bSYspc1rG6FCNNtR68268MH2n1J6jNrz6TJZzk03AloEiBw65tNUqtXptWSS4h_1Nq25yaqVoe_Pxc-7zEY8TgiUQ2OUQypqTyeCt-nU0qBDeLrw6DUXa4D1dpAlXIzS5V73BY0JRHB8P61dRmXQMd3j-_PaimzRn6vV_amZgkrqpb75CgdlNm8IjPPCOnWZygx8rYb_b_tshPp6yPSfTG6JRx1-kCG8tAtxn0AwFaPpTFYbS-GEKqrctZfDdI55FFI2nbwjBSo0Q9cHg0pS0s9tT8I66jU2tgMXF-5pyyiX33dZxcah0mVbuq0lhCuESaXlsaOYBO2oGfVqY2nmyHWLKxjlFXEN_xStM2NfWCbM7we1pCjoiDKkyUot3mk76ueHqDnhDXDVH_Gb1mVY2EuDC2bWJlTMtpqifEP0-s6P6wBV2pUk7UZOpi-5LKfRi-275wq4HowGhp0zXQVOHE2FLxZFkvKa2s9PSy435-zArBUKAkCjvwo5oy-oRxnXzj7PbYBFiWXHrx40fmR0gSoHnnGdFOA0pDH-who97ytP8hSe1SflW9NIESz56kPKP5W1sgERgzjXF-nvcnh5_tIipuRB5bI9cz6l8wH5mDfRhEKfke6WCTVAOeZ0OmdOSPYujxUhEQp9S1pUJMurn3ei3sZKsGcaCHyJYz9pqUkpIXwTmlN5oYqZYc-LbnQ_Mi6fZnh0NjFh-phAMs21tNystsU8XCBNBpNL-F9VzGo-bHVkB947BW4JpqEX-_xqRdNQ1UVJyUJHgMT4E8m-xISRuwyrMf8LmM2AZ-A0CAXPHsCE7ZV8ZgFTNZuCOp53Q4jYI6-OXD9on6THs9DHYtJ2zjZNjgUi8b5bHBQE78XGMirfe49AFnHk2qpV0aaeMGUdwIFvlx90lLBnqU2SzB0lOpCP1SJAm2nhPDWW9dsTWROkIvLnta2tdTARzBmDF05fdQj74pjyf4Ii1DMl3X8EJ6tz8YPoSfOkXI3trC8RJ61_JV57op2LLDhRuiZW0-ZnwyyMb9yARoz-uAfl2ExmXoM6ZkwVDa6PTuWbdcXPDlHxKqnYk8p1h8DllXZuwESQKiyOWTzorzWHuiiGAYq4wN9kMkTf-MV3_VK16vaQMrpqyIU5_8ll4G_4tGamSbRiUloQP6SY_tjGg6P9yca8TEwq3fNlr80WBOZaqq5jG8CBka0s2UUTUR74UT-LAYMGFEhE14QryiA_3Hjve48Dvct1rUEpDoRW-r43LNq7ItIoBVNeCjm5Y3ecyP-6RZZmad5Acl-D3gYSeMdYAS8IborrKb9aiElvQzz7IrgG-0CGtcbKVmqUOwq-DOc-AWbZgn3Cqd6swnBXU87DUIJt1udZEvHtERSqaHP5bUbePt2dTmIYnL_2nugmx1LztfTSoKSpW7OlKoPvntgftnGsThDmYL0J09JCe5I92eaaGLxkergKmWU59SCrG8h3SfY5pu8raPXk7htsJS2_GQlDb4A9cQuur8:A8ORB57r52Wx949908aRPg"}', 'second', '{"id": "cbadcbdf-b591-4d95-b97f-ba3f00ef3724", "name": "Admin", "type": "user"}', NULL, '2026-10-25 17:34:16.436+00');


--
-- Data for Name: targets; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.targets VALUES ('e71180e3-1834-4269-85e5-9d8e83fe7aaf', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'bf51756a-e145-4081-b085-b7f9f5914c2a', 'backend.example.com:8080', 50, '{}', '2026-10-25 17:34:15.198457+00', '2026-10-25 17:34:15.198457+00');
INSERT INTO public.targets VALUES ('89daa950-9498-4bfa-af79-49c75b407b70', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'bf51756a-e145-4081-b085-b7f9f5914c2a', 'backend2.example.com:8080', 100, '{}', '2026-10-25 17:34:15.217846+00', '2026-10-25 17:34:15.217846+00');
INSERT INTO public.targets VALUES ('63fc9770-e933-45d5-943e-18e8efec4162', 'f549c314-49d9-4638-ab71-b2a764918c5e', '1acade81-f636-4a1f-b2dd-d26ae70aafd9', 'backend.example.com:8080', 50, '{}', '2026-10-25 17:34:15.578977+00', '2026-10-25 17:34:15.578977+00');
INSERT INTO public.targets VALUES ('f8fec68a-6e5c-4710-95c6-32a04682094a', 'f549c314-49d9-4638-ab71-b2a764918c5e', '1acade81-f636-4a1f-b2dd-d26ae70aafd9', 'backend2.example.com:8080', 100, '{}', '2026-10-25 17:34:15.587937+00', '2026-10-25 17:34:15.587937+00');
INSERT INTO public.targets VALUES ('b7c4cdda-71c4-4aa8-bca3-30084b55ff55', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', '9489cb73-67be-48da-92b9-11cb406bbd3a', 'backend.example.com:8080', 50, '{}', '2026-10-25 17:34:15.924866+00', '2026-10-25 17:34:15.924866+00');
INSERT INTO public.targets VALUES ('84512f4d-6fbd-4cce-b390-d769560d5d36', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', '9489cb73-67be-48da-92b9-11cb406bbd3a', 'backend2.example.com:8080', 100, '{}', '2026-10-25 17:34:15.933604+00', '2026-10-25 17:34:15.933604+00');
INSERT INTO public.targets VALUES ('04a2c266-bf1c-44e0-8d1c-ed3b5926ab50', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'd30a306d-9e79-4ade-a34d-0efa6bd085f3', 'backend.example.com:8080', 50, '{}', '2026-10-25 17:34:16.182248+00', '2026-10-25 17:34:16.182248+00');
INSERT INTO public.targets VALUES ('4f613f7c-ebd5-4d1f-835e-9fdcc0e2cc05', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'd30a306d-9e79-4ade-a34d-0efa6bd085f3', 'backend2.example.com:8080', 100, '{}', '2026-10-25 17:34:16.189893+00', '2026-10-25 17:34:16.189893+00');


--
-- Data for Name: upstreams; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.upstreams VALUES ('bf51756a-e145-4081-b085-b7f9f5914c2a', 'cb880720-f6e4-4621-82fb-2776eb8007b1', 'pool', 'consistent-hashing', 'header', 'none', 'X-Client', NULL, NULL, NULL, '{"active": null, "passive": null}', '{}', '2026-10-25 17:34:15.172501+00', '2026-10-25 17:34:15.172501+00');
INSERT INTO public.upstreams VALUES ('1acade81-f636-4a1f-b2dd-d26ae70aafd9', 'f549c314-49d9-4638-ab71-b2a764918c5e', 'pool', 'consistent-hashing', 'header', 'none', 'X-Client', NULL, NULL, NULL, '{"active": null, "passive": null}', '{}', '2026-10-25 17:34:15.572436+00', '2026-10-25 17:34:15.572436+00');
INSERT INTO public.upstreams VALUES ('9489cb73-67be-48da-92b9-11cb406bbd3a', '26483d97-1fc7-4e4f-b947-05fdb7258cf8', 'pool', 'consistent-hashing', 'header', 'none', 'X-Client', NULL, NULL, NULL, '{"active": null, "passive": null}', '{}', '2026-10-25 17:34:15.917163+00', '2026-10-25 17:34:15.917163+00');
INSERT INTO public.upstreams VALUES ('d30a306d-9e79-4ade-a34d-0efa6bd085f3', 'd3fb7048-4cde-4f7d-b781-67a2b1b5711c', 'pool', 'consistent-hashing', 'header', 'none', 'X-Client', NULL, NULL, NULL, '{"active": null, "passive": null}', '{}', '2026-10-25 17:34:16.17323+00', '2026-10-25 17:34:16.17323+00');


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.users VALUES ('cbadcbdf-b591-4d95-b97f-ba3f00ef3724', 'admin@harness.test', 'Admin', 'admin', true, '$argon2id$v=19$m=19456,t=2,p=1$ztRBHmoSau1y7KPzylpjVA$6byEk5REdwdZsX2kzRM6rqDi6jMdG70m2vJtBrYgTRE', '2026-10-25 17:34:14.915575+00', '2026-10-25 17:34:14.915575+00');


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE SET; Schema: drizzle; Owner: -
--

SELECT pg_catalog.setval('drizzle.__drizzle_migrations_id_seq', 12, true);


--
-- Name: __drizzle_migrations __drizzle_migrations_pkey; Type: CONSTRAINT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations
    ADD CONSTRAINT __drizzle_migrations_pkey PRIMARY KEY (id);


--
-- Name: api_tokens api_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_pkey PRIMARY KEY (id);


--
-- Name: audit_events audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);


--
-- Name: basicauth_credentials basicauth_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.basicauth_credentials
    ADD CONSTRAINT basicauth_credentials_pkey PRIMARY KEY (id);


--
-- Name: certificate_snis certificate_snis_environment_id_name_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.certificate_snis
    ADD CONSTRAINT certificate_snis_environment_id_name_pk PRIMARY KEY (environment_id, name);


--
-- Name: certificates certificates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.certificates
    ADD CONSTRAINT certificates_pkey PRIMARY KEY (id);


--
-- Name: cluster_nodes cluster_nodes_cluster_id_node_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cluster_nodes
    ADD CONSTRAINT cluster_nodes_cluster_id_node_id_pk PRIMARY KEY (cluster_id, node_id);


--
-- Name: clusters clusters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clusters
    ADD CONSTRAINT clusters_pkey PRIMARY KEY (id);


--
-- Name: consumers consumers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consumers
    ADD CONSTRAINT consumers_pkey PRIMARY KEY (id);


--
-- Name: environment_roles environment_roles_user_id_environment_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environment_roles
    ADD CONSTRAINT environment_roles_user_id_environment_id_pk PRIMARY KEY (user_id, environment_id);


--
-- Name: environments environments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environments
    ADD CONSTRAINT environments_pkey PRIMARY KEY (id);


--
-- Name: jwt_credentials jwt_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jwt_credentials
    ADD CONSTRAINT jwt_credentials_pkey PRIMARY KEY (id);


--
-- Name: keyauth_credentials keyauth_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keyauth_credentials
    ADD CONSTRAINT keyauth_credentials_pkey PRIMARY KEY (id);


--
-- Name: login_attempts login_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_attempts
    ADD CONSTRAINT login_attempts_pkey PRIMARY KEY (key);


--
-- Name: plugins plugins_env_scope_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugins
    ADD CONSTRAINT plugins_env_scope_uq UNIQUE NULLS NOT DISTINCT (environment_id, name, service_id, route_id, consumer_id);


--
-- Name: plugins plugins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugins
    ADD CONSTRAINT plugins_pkey PRIMARY KEY (id);


--
-- Name: routes routes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.routes
    ADD CONSTRAINT routes_pkey PRIMARY KEY (id);


--
-- Name: services services_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.services
    ADD CONSTRAINT services_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id_hash);


--
-- Name: snapshots snapshots_environment_id_version_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshots
    ADD CONSTRAINT snapshots_environment_id_version_pk PRIMARY KEY (environment_id, version);


--
-- Name: targets targets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.targets
    ADD CONSTRAINT targets_pkey PRIMARY KEY (id);


--
-- Name: upstreams upstreams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upstreams
    ADD CONSTRAINT upstreams_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: api_tokens_hash_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX api_tokens_hash_uq ON public.api_tokens USING btree (token_hash);


--
-- Name: api_tokens_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_tokens_user_idx ON public.api_tokens USING btree (user_id);


--
-- Name: audit_events_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_at_idx ON public.audit_events USING btree (at);


--
-- Name: audit_events_env_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_env_idx ON public.audit_events USING btree (environment_id);


--
-- Name: basicauth_consumer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX basicauth_consumer_idx ON public.basicauth_credentials USING btree (consumer_id);


--
-- Name: basicauth_env_username_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX basicauth_env_username_uq ON public.basicauth_credentials USING btree (environment_id, username);


--
-- Name: certificate_snis_cert_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX certificate_snis_cert_idx ON public.certificate_snis USING btree (certificate_id);


--
-- Name: certificates_env_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX certificates_env_idx ON public.certificates USING btree (environment_id);


--
-- Name: cluster_nodes_token_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX cluster_nodes_token_uq ON public.cluster_nodes USING btree (token_hash);


--
-- Name: clusters_env_name_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX clusters_env_name_uq ON public.clusters USING btree (environment_id, name);


--
-- Name: clusters_token_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX clusters_token_uq ON public.clusters USING btree (registration_token_hash);


--
-- Name: consumers_env_custom_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX consumers_env_custom_id_uq ON public.consumers USING btree (environment_id, custom_id);


--
-- Name: consumers_env_username_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX consumers_env_username_uq ON public.consumers USING btree (environment_id, username);


--
-- Name: environment_roles_env_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX environment_roles_env_idx ON public.environment_roles USING btree (environment_id);


--
-- Name: environments_name_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX environments_name_uq ON public.environments USING btree (name);


--
-- Name: jwt_consumer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jwt_consumer_idx ON public.jwt_credentials USING btree (consumer_id);


--
-- Name: jwt_env_key_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX jwt_env_key_uq ON public.jwt_credentials USING btree (environment_id, key);


--
-- Name: keyauth_consumer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX keyauth_consumer_idx ON public.keyauth_credentials USING btree (consumer_id);


--
-- Name: keyauth_env_key_hash_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX keyauth_env_key_hash_uq ON public.keyauth_credentials USING btree (environment_id, key_hash);


--
-- Name: routes_env_name_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX routes_env_name_uq ON public.routes USING btree (environment_id, name);


--
-- Name: routes_service_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX routes_service_idx ON public.routes USING btree (service_id);


--
-- Name: services_env_name_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX services_env_name_uq ON public.services USING btree (environment_id, name);


--
-- Name: sessions_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_expires_idx ON public.sessions USING btree (expires_at);


--
-- Name: sessions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_idx ON public.sessions USING btree (user_id);


--
-- Name: targets_env_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX targets_env_idx ON public.targets USING btree (environment_id);


--
-- Name: targets_upstream_target_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX targets_upstream_target_uq ON public.targets USING btree (upstream_id, target);


--
-- Name: upstreams_env_name_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX upstreams_env_name_uq ON public.upstreams USING btree (environment_id, name);


--
-- Name: users_email_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_email_uq ON public.users USING btree (email);


--
-- Name: api_tokens api_tokens_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: basicauth_credentials basicauth_credentials_consumer_id_consumers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.basicauth_credentials
    ADD CONSTRAINT basicauth_credentials_consumer_id_consumers_id_fk FOREIGN KEY (consumer_id) REFERENCES public.consumers(id) ON DELETE CASCADE;


--
-- Name: basicauth_credentials basicauth_credentials_environment_id_environments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.basicauth_credentials
    ADD CONSTRAINT basicauth_credentials_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: certificate_snis certificate_snis_certificate_id_certificates_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.certificate_snis
    ADD CONSTRAINT certificate_snis_certificate_id_certificates_id_fk FOREIGN KEY (certificate_id) REFERENCES public.certificates(id) ON DELETE CASCADE;


--
-- Name: certificate_snis certificate_snis_environment_id_environments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.certificate_snis
    ADD CONSTRAINT certificate_snis_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: certificates certificates_environment_id_environments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.certificates
    ADD CONSTRAINT certificates_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: cluster_nodes cluster_nodes_cluster_id_clusters_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cluster_nodes
    ADD CONSTRAINT cluster_nodes_cluster_id_clusters_id_fk FOREIGN KEY (cluster_id) REFERENCES public.clusters(id) ON DELETE CASCADE;


--
-- Name: clusters clusters_environment_id_environments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clusters
    ADD CONSTRAINT clusters_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE RESTRICT;


--
-- Name: consumers consumers_environment_id_environments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consumers
    ADD CONSTRAINT consumers_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: environment_roles environment_roles_environment_id_environments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environment_roles
    ADD CONSTRAINT environment_roles_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: environment_roles environment_roles_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.environment_roles
    ADD CONSTRAINT environment_roles_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: jwt_credentials jwt_credentials_consumer_id_consumers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jwt_credentials
    ADD CONSTRAINT jwt_credentials_consumer_id_consumers_id_fk FOREIGN KEY (consumer_id) REFERENCES public.consumers(id) ON DELETE CASCADE;


--
-- Name: jwt_credentials jwt_credentials_environment_id_environments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jwt_credentials
    ADD CONSTRAINT jwt_credentials_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: keyauth_credentials keyauth_credentials_consumer_id_consumers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keyauth_credentials
    ADD CONSTRAINT keyauth_credentials_consumer_id_consumers_id_fk FOREIGN KEY (consumer_id) REFERENCES public.consumers(id) ON DELETE CASCADE;


--
-- Name: keyauth_credentials keyauth_credentials_environment_id_environments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.keyauth_credentials
    ADD CONSTRAINT keyauth_credentials_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: plugins plugins_consumer_id_consumers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugins
    ADD CONSTRAINT plugins_consumer_id_consumers_id_fk FOREIGN KEY (consumer_id) REFERENCES public.consumers(id) ON DELETE CASCADE;


--
-- Name: plugins plugins_environment_id_environments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugins
    ADD CONSTRAINT plugins_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: plugins plugins_route_id_routes_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugins
    ADD CONSTRAINT plugins_route_id_routes_id_fk FOREIGN KEY (route_id) REFERENCES public.routes(id) ON DELETE CASCADE;


--
-- Name: plugins plugins_service_id_services_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugins
    ADD CONSTRAINT plugins_service_id_services_id_fk FOREIGN KEY (service_id) REFERENCES public.services(id) ON DELETE CASCADE;


--
-- Name: routes routes_environment_id_environments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.routes
    ADD CONSTRAINT routes_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: routes routes_service_id_services_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.routes
    ADD CONSTRAINT routes_service_id_services_id_fk FOREIGN KEY (service_id) REFERENCES public.services(id) ON DELETE RESTRICT;


--
-- Name: services services_environment_id_environments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.services
    ADD CONSTRAINT services_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: snapshots snapshots_environment_id_environments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshots
    ADD CONSTRAINT snapshots_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: targets targets_environment_id_environments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.targets
    ADD CONSTRAINT targets_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- Name: targets targets_upstream_id_upstreams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.targets
    ADD CONSTRAINT targets_upstream_id_upstreams_id_fk FOREIGN KEY (upstream_id) REFERENCES public.upstreams(id) ON DELETE CASCADE;


--
-- Name: upstreams upstreams_environment_id_environments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upstreams
    ADD CONSTRAINT upstreams_environment_id_environments_id_fk FOREIGN KEY (environment_id) REFERENCES public.environments(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict 50bibgOZezJQeNoAQCmn3t2uWpKlpKeDbYnsckDHs7edei5sCba0UZ0Q3A6mfB1

