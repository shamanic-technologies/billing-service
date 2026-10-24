-- The last features-service catalogue answer billing read, per key
-- (CAPS-READ-FEATURES-DOWN-1024). `sales_funnel:<id>` holds a funnel's detail
-- body, `sales_path_terms` the published channels + sourcing origins. Read when
-- features-service is slow or down, so a funnel billing has read once never holds
-- a client's caps read or authorize again (prod 2026-10-24: AscendQE + CeXO AI sent
-- nothing all day while funded). A cache of features-service's answer, never a
-- source of truth: every successful read overwrites it.
CREATE TABLE IF NOT EXISTS features_catalogue_snapshots (
  key text PRIMARY KEY,
  body jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
