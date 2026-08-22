/**
 * The distribution the domain points at (plan §14.8).
 *
 * ## Nothing HTML is cached, and that is the whole caching policy
 *
 * Every behaviour below except static assets uses `CachingDisabled`. That looks
 * like leaving performance on the table, and it is deliberate.
 *
 * This platform serves signed-in shop staff, signed-in customers, and guests
 * carrying a cart cookie, all from the same paths. A cache key that misses one
 * cookie serves one person's page to another — an account page, an order, a
 * till. That failure is silent, it is a data breach rather than a bug, and it
 * is discovered by a customer. The upside of getting it right is a few hundred
 * milliseconds on a page Next already caches at the origin with ISR.
 *
 * Storefront pages *are* cacheable in principle, and doing it properly means a
 * cache policy keyed on the exact cookie set, applied only to paths proven to
 * be anonymous. That is a deliberate piece of work with a test behind it, not a
 * default to leave switched on.
 */

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  # Forwards every viewer header, cookie and query string except Host. The
  # exception matters: the origin is an ALB that must see its own hostname.
  # Everything else reaches the application, `Stripe-Signature` included.
  name = "Managed-AllViewerExceptHostHeader"
}

/**
 * Security headers added at the edge, not in the app.
 *
 * HSTS in particular: it must be present on every response including error
 * pages and redirects, and an application only sets it on responses it
 * generates. The app already sets frame, content-type and referrer policies —
 * these are additive rather than a replacement.
 */
resource "aws_cloudfront_response_headers_policy" "security" {
  name = "${var.name}-security"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = false
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = false
    }
  }
}

resource "aws_cloudfront_distribution" "app" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${var.name} application"
  aliases         = [var.domain_name]
  price_class     = var.price_class
  web_acl_id      = aws_wafv2_web_acl.this.arn

  origin {
    origin_id   = "alb"
    domain_name = var.alb_dns_name

    custom_origin_config {
      http_port  = 80
      https_port = 443
      # HTTPS to the origin as well as from the viewer: §14.8 wants traffic
      # encrypted inside the VPC, not only in front of it.
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      # Longer than the ALB's own idle timeout would allow a request to outlive
      # its origin; shorter would cut off a slow export. Matched deliberately.
      origin_read_timeout = 60
    }

    # What proves this distribution is ours. The ALB refuses anything without
    # it — see the compute module's listener, which defaults to 403.
    custom_header {
      name  = var.origin_secret_header_name
      value = var.origin_secret
    }
  }

  default_cache_behavior {
    target_origin_id       = "alb"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  /**
   * The one thing worth caching: Next's hashed build output.
   *
   * Every filename under this prefix contains a content hash, so a change
   * produces a new URL and a stale entry can never be served for new content.
   * That is what makes a long TTL safe here and unsafe almost everywhere else.
   */
  ordered_cache_behavior {
    path_pattern           = "/_next/static/*"
    target_origin_id       = "alb"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  /**
   * Webhooks: never cached, every header forwarded.
   *
   * A cached webhook response would mean Stripe being told "delivered" for an
   * event nothing processed. Forwarding headers is equally load-bearing: the
   * signature travels in `Stripe-Signature`, and CloudFront strips headers by
   * default — a distribution that drops it turns every webhook into a
   * verification failure that looks like an attack.
   */
  ordered_cache_behavior {
    path_pattern           = "/api/v1/webhooks/*"
    target_origin_id       = "alb"
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = false

    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = var.tags
}

# ── DNS ──────────────────────────────────────────────────────────────────────

resource "aws_route53_record" "app" {
  for_each = toset(["A", "AAAA"])

  zone_id = var.hosted_zone_id
  name    = var.domain_name
  type    = each.key

  alias {
    name    = aws_cloudfront_distribution.app.domain_name
    zone_id = aws_cloudfront_distribution.app.hosted_zone_id
    # Alias health evaluation against CloudFront is not meaningful — the
    # distribution is always "healthy" from Route 53's perspective.
    evaluate_target_health = false
  }
}
