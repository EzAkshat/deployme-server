-- Notification payloads contain IDs only. PostgreSQL delivers these after commit.
-- No deployment/log data is copied or deleted by this migration.
CREATE FUNCTION deployme_notify_deployment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('deployme_project_activity', OLD."projectId");
  ELSE
    PERFORM pg_notify('deployme_project_activity', NEW."projectId");
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER deployme_deployment_activity
AFTER INSERT OR UPDATE OR DELETE ON "Deployment"
FOR EACH ROW EXECUTE FUNCTION deployme_notify_deployment();

CREATE FUNCTION deployme_notify_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('deployme_project_activity', OLD.id);
  ELSE
    PERFORM pg_notify('deployme_project_activity', NEW.id);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER deployme_project_activity
AFTER UPDATE OR DELETE ON "Project"
FOR EACH ROW EXECUTE FUNCTION deployme_notify_project();

-- READY is finalized before the routing outbox publishes the public website.
CREATE FUNCTION deployme_notify_routing() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project_id text;
BEGIN
  IF NEW."eventType" = 'DEPLOYMENT_ROUTING_REQUESTED'
     AND NEW."processedAt" IS NOT NULL AND OLD."processedAt" IS NULL THEN
    SELECT "projectId" INTO project_id FROM "Deployment" WHERE id = NEW."deploymentId";
    IF project_id IS NOT NULL THEN
      PERFORM pg_notify('deployme_project_activity', project_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER deployme_routing_activity
AFTER UPDATE OF "processedAt" ON "DeploymentOutbox"
FOR EACH ROW EXECUTE FUNCTION deployme_notify_routing();
