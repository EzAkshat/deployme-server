-- Notify connected project viewers when resource measurements change.
-- Payloads contain only project IDs and are delivered after commit.

CREATE FUNCTION deployme_notify_resource_usage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  deployment_id text;
  project_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    deployment_id := OLD."deploymentId";
  ELSE
    deployment_id := NEW."deploymentId";
  END IF;

  SELECT "projectId"
  INTO project_id
  FROM "Deployment"
  WHERE id = deployment_id;

  IF project_id IS NOT NULL THEN
    PERFORM pg_notify('deployme_project_activity', project_id);
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER deployme_resource_usage_activity
AFTER INSERT OR UPDATE OR DELETE ON "DeploymentResourceUsage"
FOR EACH ROW
EXECUTE FUNCTION deployme_notify_resource_usage();