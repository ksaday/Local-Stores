/**
 * Staging (plan §14.2).
 *
 * Deliberately the same file as ../production/main.tf with different numbers.
 * §14.2 says staging runs the same images and the same migrations as
 * production, and that only holds if the two roots differ in sizing and
 * posture rather than in shape — a staging environment assembled differently
 * stops being evidence about production.
 *
 * What differs, and why:
 *   - one NAT gateway instead of two (~$35/month; an AZ-loss risk staging can take)
 *   - single-AZ RDS on a smaller class, per §14.2's table
 *   - 7-day backups instead of 35: no PITR commitment applies here
 *   - one Redis node, so no automatic failover
 *   - no deletion protection — staging is meant to be rebuildable
 *   - ECS Exec enabled, so a shell into a task needs no change to get one
 *   - traces sampled at 100%, because volume is low and the point is debugging
 */

terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }

    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  /**
   * State in S3 with locking (§14.6: "all resources reproducible from code").
   *
   * Values are supplied by `-backend-config` rather than hardcoded, because the
   * bucket is created outside this configuration — a Terraform state backend
   * cannot be managed by the configuration whose state it holds without a
   * chicken-and-egg problem on first apply.
   */
  backend "s3" {
    key     = "staging/terraform.tfstate"
    encrypt = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = local.tags
  }
}

locals {
  name = "bba-staging"

  tags = {
    Project     = "bba"
    Environment = "staging"
    ManagedBy   = "terraform"
  }
}

module "network" {
  source = "../../modules/network"

  name     = local.name
  region   = var.region
  vpc_cidr = "10.1.0.0/16"

  # Shared, and the saving is the reason. Staging can tolerate losing outbound
  # traffic with an AZ; production cannot.
  single_nat_gateway = true

  tags = local.tags
}

module "secrets" {
  source = "../../modules/secrets"

  name = local.name
  tags = local.tags
}

module "data" {
  source = "../../modules/data"

  name            = local.name
  vpc_id          = module.network.vpc_id
  data_subnet_ids = module.network.data_subnet_ids

  app_security_group_id = module.compute.tasks_security_group_id

  # Smaller and single-AZ, per §14.2's table. Load testing runs here, so this
  # is the number to raise before drawing conclusions from a load test — a
  # t4g.medium will find a ceiling that says nothing about db.m7g.large.
  db_instance_class        = "db.t4g.medium"
  db_allocated_storage     = 50
  db_max_allocated_storage = 200

  multi_az = false

  backup_retention_days = 7

  # Staging is meant to be rebuildable from scratch.
  deletion_protection = false

  redis_node_type  = "cache.t4g.micro"
  redis_node_count = 1

  tags = local.tags
}

module "compute" {
  source = "../../modules/compute"

  name              = local.name
  region            = var.region
  vpc_id            = module.network.vpc_id
  public_subnet_ids = module.network.public_subnet_ids
  app_subnet_ids    = module.network.app_subnet_ids

  certificate_arn = module.dns.alb_certificate_arn

  api_image = module.secrets.api_repository_url
  web_image = module.secrets.web_repository_url
  image_tag = var.image_tag

  # One of each, and low ceilings: staging exists to be correct, not to absorb
  # traffic. Raise these deliberately for a load test rather than leaving room
  # that quietly costs money every day.
  web_desired_count = 1
  web_max_count     = 4
  api_desired_count = 1
  api_max_count     = 4
  worker_desired_count = 1
  worker_max_count     = 2

  log_retention_days = 14

  otlp_endpoint = var.otlp_endpoint
  # Every trace kept. Volume is low and the reason to have traces here is to
  # read them, not to sample them.
  trace_baseline_ratio = 1.0

  database_url_secret_arn    = module.secrets.database_url_arn
  redis_url_secret_arn       = module.secrets.redis_url_arn
  jwt_private_key_secret_arn = module.secrets.jwt_private_key_arn
  stripe_secret_key_arn      = module.secrets.stripe_secret_key_arn
  stripe_webhook_secret_arn  = module.secrets.stripe_webhook_secret_arn
  secret_arns                = module.secrets.all_secret_arns

  origin_secret = random_password.origin_secret.result

  media_bucket_arn = module.storage.media_bucket_arn

  enable_execute_command = true

  deletion_protection = false

  tags = local.tags
}

/**
 * A second provider, pinned to us-east-1.
 *
 * CloudFront's certificate and its WAF web ACL must live there whatever region
 * the rest of this runs in. Passed explicitly to the modules that need it, so
 * the constraint is visible here rather than surfacing as an apply-time error.
 */
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = local.tags
  }
}

/**
 * The secret CloudFront sends and the load balancer requires.
 *
 * Generated rather than configured, because nobody needs to know it and a
 * value a human chose is a value that ends up in a chat message. It lands in
 * Terraform state, which is why the load balancer treats it as proof of origin
 * and never as authentication — the controls that matter are the session
 * cookie and, for webhooks, Stripe's signature.
 */
resource "random_password" "origin_secret" {
  length  = 48
  special = false
}

module "storage" {
  source = "../../modules/storage"

  bucket_name = var.media_bucket_name
  domain_name = var.domain_name

  tags = local.tags
}

module "dns" {
  source = "../../modules/dns"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name             = local.name
  hosted_zone_name = var.hosted_zone_name
  domain_name      = var.domain_name
  cdn_domain_name  = var.cdn_domain_name

  tags = local.tags
}

module "edge" {
  source = "../../modules/edge"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name            = local.name
  hosted_zone_id  = module.dns.zone_id
  certificate_arn = module.dns.cloudfront_certificate_arn
  domain_name     = var.domain_name
  cdn_domain_name = var.cdn_domain_name

  media_bucket_name                 = module.storage.media_bucket_name
  media_bucket_arn                  = module.storage.media_bucket_arn
  media_bucket_regional_domain_name = module.storage.media_bucket_regional_domain_name

  alb_dns_name = module.compute.alb_dns_name

  origin_secret = random_password.origin_secret.result

  stripe_ip_ranges = var.stripe_ip_ranges

  tags = local.tags
}
