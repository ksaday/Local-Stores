output "vpc_id" {
  value = aws_vpc.this.id
}

output "vpc_cidr" {
  value = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  description = "For the load balancer only. Nothing else belongs here."
  value       = aws_subnet.public[*].id
}

output "app_subnet_ids" {
  description = "ECS tasks. Reachable from the load balancer, not from the internet."
  value       = aws_subnet.app[*].id
}

output "data_subnet_ids" {
  description = "RDS and ElastiCache. No route to the internet at all."
  value       = aws_subnet.data[*].id
}
