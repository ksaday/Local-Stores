variable "name" { type = string }
variable "vpc_id" { type = string }
variable "data_subnet_ids" { type = list(string) }

variable "postgres_version" {
  type    = string
  default = "16.11"
}

variable "db_instance_class" {
  description = "§14.4 baseline is db.m7g.large in production."
  type        = string
  default     = "db.t4g.medium"
}

variable "db_allocated_storage" {
  type    = number
  default = 50
}

variable "db_max_allocated_storage" {
  description = "Ceiling for storage autoscaling. Set above allocated, or growth needs an outage."
  type        = number
  default     = 500
}

variable "master_username" {
  type    = string
  default = "bba_root"
}

variable "multi_az" {
  description = "Production only. §14.2 runs staging single-AZ deliberately."
  type        = bool
  default     = false
}

variable "backup_retention_days" {
  description = "§14.6 requires 35 in production for PITR."
  type        = number
  default     = 7
}

variable "deletion_protection" {
  description = "Also decides whether a final snapshot is taken on destroy."
  type        = bool
  default     = false
}

variable "redis_version" {
  type    = string
  default = "7.1"
}

variable "redis_node_type" {
  description = "§14.4 baseline is cache.t4g.medium."
  type        = string
  default     = "cache.t4g.micro"
}

variable "redis_node_count" {
  description = "More than one enables automatic failover and multi-AZ."
  type        = number
  default     = 1
}

variable "tags" {
  type    = map(string)
  default = {}
}
