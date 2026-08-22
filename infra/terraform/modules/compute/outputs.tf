output "tasks_security_group_id" {
  description = "Granted access by the data tier. A security group, never a CIDR."
  value       = aws_security_group.tasks.id
}

output "alb_dns_name" {
  description = "CloudFront's origin. Not a name anybody should be given directly."
  value       = aws_lb.this.dns_name
}

output "alb_zone_id" {
  value = aws_lb.this.zone_id
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "task_role_arn" {
  value = aws_iam_role.task.arn
}

output "pgbouncer_security_group_id" {
  description = <<-EOT
    Granted access by the data tier instead of the whole app tier. With a
    pooler in front, an application task has no reason to reach Postgres
    directly, and this is what makes that true rather than merely intended.
  EOT
  value       = aws_security_group.pgbouncer.id
}

output "pgbouncer_host" {
  description = "Private DNS. The application's DATABASE_URL points here, not at RDS."
  value       = "pgbouncer.${var.service_discovery_namespace}"
}
