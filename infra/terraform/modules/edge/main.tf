/**
 * CloudFront, WAF, ACM and Route 53 (plan §14.1, §14.8).
 *
 * Everything the internet touches terminates here. The load balancer behind it
 * accepts nothing else — CloudFront's origin-facing ranges plus a shared secret
 * header, both enforced in the compute module.
 *
 * ## us-east-1, and not by choice
 *
 * A WAF web ACL scoped to CLOUDFRONT must be created in us-east-1 whatever
 * region everything else runs in, which is why this module takes an aliased
 * provider rather than inheriting one — the alias makes the constraint visible
 * at the call site instead of failing at apply with a message about the wrong
 * region. Certificates have the same rule and live in modules/dns, which owns
 * both regions' copies; see there for why they are not here.
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

# ── WAF ──────────────────────────────────────────────────────────────────────

resource "aws_wafv2_web_acl" "this" {
  provider = aws.us_east_1

  name  = "${var.name}-edge"
  scope = "CLOUDFRONT"

  default_action {
    allow {}
  }

  /**
   * AWS's common rule set, with two rules excluded and a reason for each.
   *
   * Blanket-enabling a managed rule group on an application that accepts real
   * user text is how a shop owner discovers their product description cannot
   * contain the word "select". Both exclusions below are body-inspection rules
   * that fire on ordinary commerce content.
   */
  rule {
    name     = "common"
    priority = 10

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"

        # Product descriptions and shop addresses routinely exceed the default
        # body size expectations; the API's own validation bounds them.
        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }

        # Fires on legitimate rich text in descriptions and customer notes.
        # XSS is prevented by escaping at render, not by guessing at the edge.
        rule_action_override {
          name = "CrossSiteScripting_BODY"
          action_to_use {
            count {}
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "known-bad-inputs"
    priority = 20

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  /**
   * Rate limit, per IP, five minutes.
   *
   * Deliberately generous. A shop's own staff on one office NAT share a source
   * address, and so does a block of flats — a limit tuned to stop a determined
   * attacker also stops a busy Saturday. The application already rate-limits
   * the endpoints that matter by account rather than by address, which is the
   * control that can tell those apart. This is a blunt ceiling for traffic that
   * is obviously not a person.
   */
  rule {
    name     = "rate-limit"
    priority = 30

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = var.rate_limit_per_5min
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  /**
   * Stripe's published ranges on the webhook path (§14.1).
   *
   * Off unless `stripe_ip_ranges` is supplied, and that default is deliberate:
   * an empty allowlist that silently blocked every webhook would take payments
   * down in a way that looks like a Stripe outage. Supplying it is a decision
   * with an operational cost — Stripe changes these ranges and publishes the
   * change, and nothing here notices.
   *
   * This is defence in depth and nothing more. The real control is signature
   * verification, which the API does on every webhook and which an attacker
   * cannot pass by arriving from a permitted address.
   */
  dynamic "rule" {
    for_each = length(var.stripe_ip_ranges) > 0 ? [1] : []

    content {
      name     = "stripe-webhooks-only"
      priority = 40

      action {
        block {}
      }

      statement {
        and_statement {
          statement {
            byte_match_statement {
              search_string         = "/api/v1/webhooks/"
              positional_constraint = "STARTS_WITH"

              field_to_match {
                uri_path {}
              }

              text_transformation {
                priority = 0
                type     = "LOWERCASE"
              }
            }
          }

          statement {
            not_statement {
              statement {
                ip_set_reference_statement {
                  arn = aws_wafv2_ip_set.stripe[0].arn
                }
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${var.name}-stripe-webhooks"
        sampled_requests_enabled   = true
      }
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name}-edge"
    sampled_requests_enabled   = true
  }

  tags = var.tags
}

resource "aws_wafv2_ip_set" "stripe" {
  count    = length(var.stripe_ip_ranges) > 0 ? 1 : 0
  provider = aws.us_east_1

  name               = "${var.name}-stripe"
  scope              = "CLOUDFRONT"
  ip_address_version = "IPV4"
  addresses          = var.stripe_ip_ranges

  tags = var.tags
}
