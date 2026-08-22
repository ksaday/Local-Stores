/**
 * The hosted zone and both certificates (plan §14.8).
 *
 * ## Why certificates are not in the edge module
 *
 * The load balancer's listener needs a certificate in the deployment region,
 * and CloudFront's needs one in us-east-1 — two certificates for the same
 * names. If both lived alongside CloudFront, the graph would be circular: the
 * edge needs the load balancer's DNS name to point at it, and the load
 * balancer needs a certificate to have a listener at all.
 *
 * Pulling them into a module that depends on nothing breaks that. It is also
 * the honest shape: a certificate is a fact about a domain, not about the
 * thing currently serving it.
 */

terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = "~> 5.70"
      configuration_aliases = [aws.us_east_1]
    }
  }
}

data "aws_route53_zone" "this" {
  name         = var.hosted_zone_name
  private_zone = false
}

locals {
  names = [var.domain_name, var.cdn_domain_name]
}

# ── Regional certificate, for the load balancer ──────────────────────────────

resource "aws_acm_certificate" "regional" {
  domain_name               = var.domain_name
  subject_alternative_names = [var.cdn_domain_name]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(var.tags, { Name = "${var.name}-regional" })
}

# ── us-east-1 certificate, for CloudFront ────────────────────────────────────

resource "aws_acm_certificate" "cloudfront" {
  provider = aws.us_east_1

  domain_name               = var.domain_name
  subject_alternative_names = [var.cdn_domain_name]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(var.tags, { Name = "${var.name}-cloudfront" })
}

/**
 * One set of validation records serves both certificates.
 *
 * ACM issues the same `_acme`-style CNAME for the same domain name regardless
 * of region, so the two certificates request identical records. Creating them
 * once and letting both validate against them is why `allow_overwrite` is set:
 * without it the second certificate's records collide with the first's.
 */
resource "aws_route53_record" "validation" {
  for_each = {
    for option in aws_acm_certificate.regional.domain_validation_options :
    option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  }

  zone_id         = data.aws_route53_zone.this.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "regional" {
  certificate_arn         = aws_acm_certificate.regional.arn
  validation_record_fqdns = [for r in aws_route53_record.validation : r.fqdn]
}

resource "aws_acm_certificate_validation" "cloudfront" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.cloudfront.arn
  validation_record_fqdns = [for r in aws_route53_record.validation : r.fqdn]
}
