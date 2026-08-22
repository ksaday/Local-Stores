/**
 * The media CDN, on an origin of its own (plan §14.8).
 *
 * `cdn.<domain>` is a different origin from the app, and that is a security
 * boundary rather than a tidy URL. Media is user-uploaded: a shop owner
 * supplies the bytes. If those bytes were served from the app's origin, a
 * content-type confusion or a CSP bypass in one uploaded file would run with
 * access to the app's cookies — including the session. A separate origin means
 * the worst case is a nuisance on a domain that holds nothing.
 */

# ── Distribution ─────────────────────────────────────────────────────────────

/**
 * Origin access control, not a public bucket policy.
 *
 * OAC signs CloudFront's requests to S3 with SigV4, so the bucket can stay
 * fully private and still be readable through the distribution. The older
 * origin access identity is deprecated and does not support SSE-KMS.
 */
resource "aws_cloudfront_origin_access_control" "media" {
  name                              = "${var.name}-media"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "media" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${var.name} media"
  aliases         = [var.cdn_domain_name]
  price_class     = var.price_class

  origin {
    origin_id                = "media"
    domain_name              = var.media_bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.media.id
  }

  default_cache_behavior {
    target_origin_id       = "media"
    viewer_protocol_policy = "redirect-to-https"
    # Read-only. Uploads go straight to S3 with a presigned URL and never pass
    # through the CDN.
    allowed_methods = ["GET", "HEAD"]
    cached_methods  = ["GET", "HEAD"]
    compress        = true

    # Safe to cache hard: object keys carry a content hash, so a changed image
    # is a new URL rather than a new version of an old one.
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.media.id
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

/**
 * Headers that make user-uploaded bytes inert.
 *
 * `nosniff` stops a browser deciding an image is really HTML, and the CSP
 * denies everything: media has no reason to load a script, frame a page or
 * make a request. Between them, a file crafted to be interpreted as a document
 * gets no capabilities even if it is served as one.
 */
resource "aws_cloudfront_response_headers_policy" "media" {
  name = "${var.name}-media"

  security_headers_config {
    content_type_options {
      override = true
    }

    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      override                   = true
    }

    content_security_policy {
      content_security_policy = "default-src 'none'; img-src 'self'; media-src 'self'; sandbox"
      override                = true
    }
  }
}

resource "aws_s3_bucket_policy" "media" {
  bucket = var.media_bucket_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${var.media_bucket_arn}/*"
      Condition = {
        # Scoped to this distribution. Without it, any CloudFront distribution
        # in any AWS account could read the bucket.
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.media.arn
        }
      }
    }]
  })
}

resource "aws_route53_record" "cdn" {
  for_each = toset(["A", "AAAA"])

  zone_id = var.hosted_zone_id
  name    = var.cdn_domain_name
  type    = each.key

  alias {
    name                   = aws_cloudfront_distribution.media.domain_name
    zone_id                = aws_cloudfront_distribution.media.hosted_zone_id
    evaluate_target_health = false
  }
}
