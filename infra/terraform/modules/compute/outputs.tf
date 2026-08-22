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
