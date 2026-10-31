package httpapi

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/rsa"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"encoding/xml"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/beevik/etree"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authn"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/session"
	"github.com/crewjam/saml"
	xrv "github.com/mattermost/xml-roundtrip-validator"
)

const (
	samlStateCookiePrefix = "chaste_saml_state_"
	samlBodyLimit         = 4 << 20
	samlClockSkew         = 2 * time.Minute
	samlBearerMethod      = "urn:oasis:names:tc:SAML:2.0:cm:bearer"
)

// SAMLConfig contains operator-pinned trust. The SSO URL and signing
// certificate are never discovered from a request or from assertion content.
type SAMLConfig struct {
	IDPIssuer          string
	IDPSSOURL          string
	IDPSigningCertPEM  string
	SPEntityID         string
	ACSURL             string
	SuccessURL         string
	TrustVerifiedEmail bool
	EmailAttribute     string
	NameAttribute      string
}

type samlSignInHandler struct {
	service     *authn.Service
	secret      string
	logger      *slog.Logger
	config      SAMLConfig
	sp          *saml.ServiceProvider
	acsURL      url.URL
	certificate *x509.Certificate
}

type SAMLIdentityClaims struct {
	Issuer      string
	Subject     string
	Email       string
	Name        string
	ResponseID  string
	AssertionID string
}

// NewAuthHandlerWithFederatedRoutes composes the existing Go auth endpoints
// with independently constructed OIDC and SAML routes without changing either
// provider's default-off wiring.
func NewAuthHandlerWithFederatedRoutes(service *authn.Service, secret string, secureCookie bool, logger *slog.Logger, trustedProxyCIDRs []*net.IPNet, oidcRoutes, samlRoutes http.Handler) (http.Handler, error) {
	authRoutes, err := NewAuthHandlerWithOIDCRoutes(service, secret, secureCookie, logger, trustedProxyCIDRs, oidcRoutes)
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	mux.Handle("/", authRoutes)
	if samlRoutes != nil {
		mux.Handle("GET /sign-in/saml", samlRoutes)
		mux.Handle("POST /callback/saml", samlRoutes)
	}
	return mux, nil
}

func NewSAMLSignInHandler(service *authn.Service, secret string, secureCookie bool, logger *slog.Logger, config SAMLConfig) (http.Handler, error) {
	if service == nil || len([]byte(secret)) < 32 {
		return nil, errors.New("SAML requires the Go auth service and a 32-byte signing secret")
	}
	if !secureCookie {
		return nil, errors.New("SAML requires secure cookies because the assertion consumer uses cross-site POST")
	}
	if logger == nil {
		logger = slog.Default()
	}
	idpIssuer, err := parseSAMLURI(config.IDPIssuer, "SAML IdP issuer")
	if err != nil {
		return nil, err
	}
	idpSSO, err := parseSAMLHTTPSURL(config.IDPSSOURL, "SAML IdP SSO URL")
	if err != nil {
		return nil, err
	}
	spEntityID, err := parseSAMLURI(config.SPEntityID, "SAML SP entity ID")
	if err != nil {
		return nil, err
	}
	acsURL, err := parseSAMLHTTPSURL(config.ACSURL, "SAML ACS URL")
	if err != nil || acsURL.Path != "/api/auth/callback/saml" || acsURL.RawQuery != "" || acsURL.Fragment != "" {
		return nil, errors.New("SAML ACS URL must be an absolute HTTPS /api/auth/callback/saml URL without query or fragment")
	}
	if _, err := parseSAMLHTTPSURL(config.SuccessURL, "SAML success URL"); err != nil {
		return nil, err
	}
	if !config.TrustVerifiedEmail || strings.TrimSpace(config.EmailAttribute) == "" || len(config.EmailAttribute) > 256 || len(config.NameAttribute) > 256 {
		return nil, errors.New("SAML requires explicit verified-email trust and bounded email/name attribute names")
	}
	block, rest := pem.Decode([]byte(config.IDPSigningCertPEM))
	if block == nil || block.Type != "CERTIFICATE" || len(bytes.TrimSpace(rest)) != 0 {
		return nil, errors.New("SAML IdP signing certificate must be one PEM certificate")
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil || certificate.KeyUsage&x509.KeyUsageDigitalSignature == 0 {
		return nil, errors.New("SAML IdP signing certificate is invalid or not permitted for digital signatures")
	}
	switch publicKey := certificate.PublicKey.(type) {
	case *rsa.PublicKey:
		if publicKey.N.BitLen() < 2048 {
			return nil, errors.New("SAML IdP RSA signing certificate must use at least a 2048-bit key")
		}
	case *ecdsa.PublicKey:
		if publicKey.Curve.Params().BitSize < 256 {
			return nil, errors.New("SAML IdP ECDSA signing certificate must use at least a 256-bit curve")
		}
	default:
		return nil, errors.New("SAML IdP signing certificate uses an unsupported public key")
	}
	now := time.Now().UTC()
	if now.Before(certificate.NotBefore) || !now.Before(certificate.NotAfter) {
		return nil, errors.New("SAML IdP signing certificate is outside its validity period")
	}
	sp := &saml.ServiceProvider{
		EntityID:          spEntityID.String(),
		AcsURL:            *acsURL,
		IDPMetadata:       &saml.EntityDescriptor{EntityID: idpIssuer.String()},
		AllowIDPInitiated: false,
	}
	sp.ValidateAudienceRestriction = func(assertion *saml.Assertion) error {
		if assertion == nil || assertion.Conditions == nil || len(assertion.Conditions.AudienceRestrictions) == 0 {
			return errors.New("audience restriction is required")
		}
		for _, restriction := range assertion.Conditions.AudienceRestrictions {
			if strings.TrimSpace(restriction.Audience.Value) != sp.EntityID {
				return errors.New("audience restriction does not match SP entity ID")
			}
		}
		return nil
	}
	trustedCertificate := base64.StdEncoding.EncodeToString(certificate.Raw)
	sp.IDPCertificate = &trustedCertificate
	if idpSSO.String() == "" {
		return nil, errors.New("SAML IdP SSO URL is invalid")
	}
	handler := &samlSignInHandler{service: service, secret: secret, logger: logger, config: config, sp: sp, acsURL: *acsURL, certificate: certificate}
	mux := http.NewServeMux()
	handler.Register(mux)
	return mux, nil
}

func parseSAMLURI(value, label string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed == nil || !parsed.IsAbs() || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Scheme == "https" && parsed.Host == "") || (parsed.Scheme == "urn" && parsed.Opaque == "") || (parsed.Scheme != "https" && parsed.Scheme != "urn") {
		return nil, fmt.Errorf("%s must be a pinned absolute HTTPS or URN identifier without query or fragment", label)
	}
	return parsed, nil
}

func parseSAMLHTTPSURL(value, label string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed == nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("%s must be an absolute HTTPS URL without credentials, query, or fragment", label)
	}
	return parsed, nil
}

func (h *samlSignInHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /sign-in/saml", h.start)
	mux.HandleFunc("POST /callback/saml", h.callback)
}

func (h *samlSignInHandler) start(w http.ResponseWriter, r *http.Request) {
	allowed, retryAfter, err := h.service.AllowAuthAttempt(r.Context(), "sign-in/saml", clientIP(r.RemoteAddr))
	if err != nil {
		h.logger.Error("SAML sign-in throttle unavailable")
		writeAuthError(w, http.StatusServiceUnavailable, "saml_unavailable", "Sign-in is temporarily unavailable")
		return
	}
	if !allowed {
		w.Header().Set("Retry-After", strconv.Itoa(max(1, int(retryAfter.Seconds()))))
		writeAuthError(w, http.StatusTooManyRequests, "rate_limit_exceeded", "Too many sign-in attempts")
		return
	}
	state, err := randomOIDCString(32)
	if err != nil {
		writeAuthError(w, http.StatusInternalServerError, "internal_error", "Sign-in could not be started")
		return
	}
	request, err := h.sp.MakeAuthenticationRequest(h.config.IDPSSOURL, saml.HTTPRedirectBinding, saml.HTTPPostBinding)
	if err != nil {
		h.logger.Error("SAML authentication request could not be created")
		writeAuthError(w, http.StatusServiceUnavailable, "saml_unavailable", "Sign-in could not be started")
		return
	}
	if err := h.service.CreateSAMLTransaction(r.Context(), state, request.ID); err != nil {
		h.logger.Error("SAML transaction could not be stored")
		writeAuthError(w, http.StatusServiceUnavailable, "saml_unavailable", "Sign-in could not be started")
		return
	}
	redirect, err := request.Redirect(state, h.sp)
	if err != nil || redirect.Host != mustHost(h.config.IDPSSOURL) || redirect.Scheme != "https" {
		h.logger.Error("SAML redirect could not be generated")
		writeAuthError(w, http.StatusServiceUnavailable, "saml_unavailable", "Sign-in could not be started")
		return
	}
	cookieValue, err := session.SignSessionCookie(state, h.secret)
	if err != nil {
		writeAuthError(w, http.StatusInternalServerError, "internal_error", "Sign-in could not be started")
		return
	}
	name := samlStateCookiePrefix + oidcStateCookieSuffix(state)
	http.SetCookie(w, &http.Cookie{Name: name, Value: cookieValue, Path: h.acsURL.Path, HttpOnly: true, Secure: true, SameSite: http.SameSiteNoneMode, MaxAge: int(authn.SAMLTransactionLifetime.Seconds())})
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	http.Redirect(w, r, redirect.String(), http.StatusSeeOther)
}

func (h *samlSignInHandler) callback(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if r.Header.Get("Content-Type") != "" {
		mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || mediaType != "application/x-www-form-urlencoded" {
			writeAuthError(w, http.StatusBadRequest, "invalid_saml_response", "Sign-in response is invalid")
			return
		}
	}
	r.Body = http.MaxBytesReader(w, r.Body, samlBodyLimit)
	if err := r.ParseForm(); err != nil {
		writeAuthError(w, http.StatusBadRequest, "invalid_saml_response", "Sign-in response is invalid")
		return
	}
	if len(r.Form) != 2 || len(r.Form["RelayState"]) != 1 || len(r.Form["SAMLResponse"]) != 1 {
		writeAuthError(w, http.StatusBadRequest, "invalid_saml_response", "Sign-in response is invalid")
		return
	}
	state := r.Form.Get("RelayState")
	if len(state) < 32 || len(state) > 128 {
		writeAuthError(w, http.StatusBadRequest, "invalid_transaction", "Sign-in transaction is invalid or expired")
		return
	}
	cookieName := samlStateCookiePrefix + oidcStateCookieSuffix(state)
	cookie, err := r.Cookie(cookieName)
	if err != nil {
		writeAuthError(w, http.StatusBadRequest, "invalid_transaction", "Sign-in transaction is invalid or expired")
		return
	}
	defer http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: h.acsURL.Path, HttpOnly: true, Secure: true, SameSite: http.SameSiteNoneMode, MaxAge: -1, Expires: time.Unix(1, 0).UTC()})
	cookieState, err := session.VerifySignedCookie(cookie.Value, h.secret)
	if err != nil || subtle.ConstantTimeCompare([]byte(cookieState), []byte(state)) != 1 {
		writeAuthError(w, http.StatusBadRequest, "invalid_transaction", "Sign-in transaction is invalid or expired")
		return
	}
	encoded := r.Form.Get("SAMLResponse")
	if len(encoded) == 0 || len(encoded) > base64.StdEncoding.EncodedLen(samlBodyLimit) {
		writeAuthError(w, http.StatusBadRequest, "invalid_saml_response", "Sign-in response is invalid")
		return
	}
	responseXML, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(responseXML) == 0 || len(responseXML) > samlBodyLimit {
		writeAuthError(w, http.StatusBadRequest, "invalid_saml_response", "Sign-in response is invalid")
		return
	}
	transaction, err := h.service.LookupSAMLTransaction(r.Context(), state)
	if err != nil {
		writeAuthError(w, http.StatusBadRequest, "invalid_transaction", "Sign-in transaction is invalid or expired")
		return
	}
	claims, err := validateSAMLResponse(responseXML, transaction.RequestID, h.sp, h.acsURL, h.config.IDPIssuer, h.config.EmailAttribute, h.config.NameAttribute, h.certificate, time.Now().UTC())
	if err != nil {
		h.logger.Warn("SAML response validation failed")
		writeAuthError(w, http.StatusUnauthorized, "saml_sign_in_failed", "Sign-in could not be completed")
		return
	}
	if _, err := h.service.ConsumeSAMLTransaction(r.Context(), state, transaction.RequestID, claims.ResponseID, claims.AssertionID); err != nil {
		writeAuthError(w, http.StatusUnauthorized, "invalid_transaction", "Sign-in transaction is invalid or expired")
		return
	}
	identity, err := h.service.SignInSAML(r.Context(), claims.Issuer, claims.Subject, claims.Email, claims.Name, true, h.config.TrustVerifiedEmail)
	if err != nil {
		h.logger.Warn("SAML identity resolution failed")
		writeAuthError(w, http.StatusUnauthorized, "saml_sign_in_failed", "Sign-in could not be completed")
		return
	}
	signedSession, err := session.SignSessionCookie(identity.Session.Token, h.secret)
	if err != nil {
		_ = h.service.RevokeSession(r.Context(), identity.Session.Token)
		writeAuthError(w, http.StatusServiceUnavailable, "saml_unavailable", "Sign-in could not be completed")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: session.SessionCookieName, Value: signedSession, Path: "/", HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode, Expires: identity.Session.ExpiresAt.UTC(), MaxAge: max(0, int(time.Until(identity.Session.ExpiresAt).Seconds()))})
	http.Redirect(w, r, h.config.SuccessURL, http.StatusSeeOther)
}

func mustHost(value string) string {
	parsed, _ := url.Parse(value)
	if parsed == nil {
		return ""
	}
	return parsed.Host
}

func validateSAMLResponse(raw []byte, requestID string, sp *saml.ServiceProvider, acsURL url.URL, idpIssuer, emailAttribute, nameAttribute string, pinnedCert *x509.Certificate, now time.Time) (SAMLIdentityClaims, error) {
	var claims SAMLIdentityClaims
	if len(raw) == 0 || len(raw) > samlBodyLimit || requestID == "" || sp == nil || pinnedCert == nil || !now.Before(pinnedCert.NotAfter) || now.Before(pinnedCert.NotBefore) {
		return claims, errors.New("invalid SAML validation input")
	}
	if err := xrv.Validate(bytes.NewReader(raw)); err != nil {
		return claims, errors.New("SAML XML failed round-trip validation")
	}
	doc := etree.NewDocument()
	if err := doc.ReadFromBytes(raw); err != nil || doc.Root() == nil {
		return claims, errors.New("invalid SAML XML")
	}
	root := doc.Root()
	if root.Tag != "Response" || root.NamespaceURI() != "urn:oasis:names:tc:SAML:2.0:protocol" {
		return claims, errors.New("unexpected SAML root element")
	}
	assertions := root.FindElements("./Assertion")
	encrypted := root.FindElements("./EncryptedAssertion")
	if len(assertions) != 1 || len(encrypted) != 0 {
		return claims, errors.New("SAML response must contain exactly one plaintext assertion")
	}
	responseSignatures := root.FindElements("./Signature")
	assertionSignatures := assertions[0].FindElements("./Signature")
	if len(responseSignatures) != 1 || len(assertionSignatures) != 0 {
		return claims, errors.New("SAML response must carry exactly one response-level signature")
	}
	if err := validateSAMLSignatureStructure(responseSignatures[0]); err != nil {
		return claims, err
	}
	var response saml.Response
	if err := xml.Unmarshal(raw, &response); err != nil || response.Assertion == nil || assertions[0].NamespaceURI() != "urn:oasis:names:tc:SAML:2.0:assertion" || response.Assertion.Subject == nil || response.Assertion.Conditions == nil || response.Issuer == nil || response.Status.StatusCode.Value != saml.StatusSuccess {
		return claims, errors.New("SAML response is incomplete")
	}
	assertion := response.Assertion
	assertionIssuer, hasAssertionIssuer := samlAssertionIssuer(assertion.Issuer)
	if !hasAssertionIssuer || assertionIssuer != idpIssuer {
		return claims, errors.New("SAML assertion issuer is missing or invalid")
	}
	if response.ID == "" || assertion.ID == "" || response.Issuer.Value != idpIssuer || response.Destination != acsURL.String() || response.InResponseTo != requestID {
		return claims, errors.New("SAML response issuer, destination, or request correlation is invalid")
	}
	if ids := collectSAMLIDs(root); len(ids) != 2 || ids[response.ID] != 1 || ids[assertion.ID] != 1 || response.ID == assertion.ID {
		return claims, errors.New("SAML response contains ambiguous XML IDs")
	}
	reference := responseSignatures[0].FindElement("./SignedInfo/Reference")
	if reference == nil || reference.SelectAttrValue("URI", "") != "#"+response.ID {
		return claims, errors.New("SAML response signature does not reference the response element")
	}
	if response.IssueInstant.IsZero() || response.IssueInstant.After(now.Add(samlClockSkew)) || response.IssueInstant.Before(now.Add(-5*time.Minute)) || assertion.IssueInstant.IsZero() || assertion.IssueInstant.After(now.Add(samlClockSkew)) || assertion.IssueInstant.Before(now.Add(-5*time.Minute)) {
		return claims, errors.New("SAML response timestamps are invalid")
	}
	if assertion.Conditions.NotBefore.IsZero() || assertion.Conditions.NotOnOrAfter.IsZero() || assertion.Conditions.NotBefore.After(now.Add(samlClockSkew)) || !assertion.Conditions.NotOnOrAfter.After(now.Add(-samlClockSkew)) || len(assertion.Conditions.AudienceRestrictions) == 0 {
		return claims, errors.New("SAML assertion conditions are invalid")
	}
	for _, restriction := range assertion.Conditions.AudienceRestrictions {
		if strings.TrimSpace(restriction.Audience.Value) != sp.EntityID {
			return claims, errors.New("SAML assertion audience does not match this service provider")
		}
	}
	confirmations := assertion.Subject.SubjectConfirmations
	if len(confirmations) != 1 || confirmations[0].Method != samlBearerMethod || confirmations[0].SubjectConfirmationData == nil {
		return claims, errors.New("SAML assertion requires one bearer subject confirmation")
	}
	confirmation := confirmations[0].SubjectConfirmationData
	if confirmation.Recipient != acsURL.String() || confirmation.InResponseTo != requestID || confirmation.NotOnOrAfter.IsZero() || !confirmation.NotOnOrAfter.After(now.Add(-samlClockSkew)) || (!confirmation.NotBefore.IsZero() && confirmation.NotBefore.After(now.Add(samlClockSkew))) {
		return claims, errors.New("SAML subject confirmation is invalid")
	}
	verified, err := sp.ParseXMLResponse(raw, []string{requestID}, acsURL)
	if err != nil || verified == nil || verified.ID != assertion.ID {
		return claims, errors.New("SAML signature or protocol validation failed")
	}
	if verified.Subject == nil || verified.Subject.NameID == nil || strings.TrimSpace(verified.Subject.NameID.Value) == "" {
		return claims, errors.New("SAML subject is missing")
	}
	claims = SAMLIdentityClaims{Issuer: idpIssuer, Subject: strings.TrimSpace(verified.Subject.NameID.Value), ResponseID: response.ID, AssertionID: assertion.ID}
	emailMatches := 0
	for _, statement := range verified.AttributeStatements {
		for _, attribute := range statement.Attributes {
			if attribute.Name == emailAttribute || (attribute.FriendlyName != "" && attribute.FriendlyName == emailAttribute) {
				emailMatches++
				if len(attribute.Values) != 1 || strings.TrimSpace(attribute.Values[0].Value) == "" {
					return SAMLIdentityClaims{}, errors.New("SAML email attribute must have exactly one non-empty value")
				}
				claims.Email = strings.TrimSpace(attribute.Values[0].Value)
			}
			if nameAttribute != "" && (attribute.Name == nameAttribute || (attribute.FriendlyName != "" && attribute.FriendlyName == nameAttribute)) {
				if len(attribute.Values) == 1 {
					claims.Name = strings.TrimSpace(attribute.Values[0].Value)
				}
			}
		}
	}
	if emailMatches != 1 || claims.Email == "" {
		return SAMLIdentityClaims{}, errors.New("SAML verified email attribute is missing")
	}
	return claims, nil
}

func samlAssertionIssuer(issuer any) (string, bool) {
	switch value := issuer.(type) {
	case *saml.Issuer:
		if value == nil {
			return "", false
		}
		valueText := strings.TrimSpace(value.Value)
		return valueText, valueText != ""
	case saml.Issuer:
		valueText := strings.TrimSpace(value.Value)
		return valueText, valueText != ""
	default:
		return "", false
	}
}

func validateSAMLSignatureStructure(signature *etree.Element) error {
	if signature == nil || signature.NamespaceURI() != "http://www.w3.org/2000/09/xmldsig#" {
		return errors.New("SAML response signature namespace is invalid")
	}
	signedInfo := signature.FindElement("./SignedInfo")
	if signedInfo == nil {
		return errors.New("SAML signature SignedInfo is missing")
	}
	canonicalization := signedInfo.FindElements("./CanonicalizationMethod")
	if len(canonicalization) != 1 {
		return errors.New("SAML signature canonicalization method is invalid")
	}
	switch canonicalization[0].SelectAttrValue("Algorithm", "") {
	case "http://www.w3.org/2001/10/xml-exc-c14n#", "http://www.w3.org/2006/12/xml-c14n11", "http://www.w3.org/TR/2001/REC-xml-c14n-20010315":
	default:
		return errors.New("SAML signature canonicalization method is not allowed")
	}
	signatureMethod := signedInfo.FindElement("./SignatureMethod")
	if signatureMethod == nil {
		return errors.New("SAML signature method is missing")
	}
	method := signatureMethod.SelectAttrValue("Algorithm", "")
	allowedMethods := map[string]struct{}{
		"http://www.w3.org/2001/04/xmldsig-more#rsa-sha256":   {},
		"http://www.w3.org/2001/04/xmldsig-more#rsa-sha384":   {},
		"http://www.w3.org/2001/04/xmldsig-more#rsa-sha512":   {},
		"http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256": {},
		"http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha384": {},
		"http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha512": {},
	}
	if _, ok := allowedMethods[method]; !ok {
		return errors.New("SAML signature algorithm is not allowed")
	}
	references := signedInfo.FindElements("./Reference")
	if len(references) != 1 {
		return errors.New("SAML signature must have exactly one reference")
	}
	digest := references[0].FindElement("./DigestMethod")
	if digest == nil {
		return errors.New("SAML signature digest method is missing")
	}
	allowedDigests := map[string]struct{}{
		"http://www.w3.org/2001/04/xmlenc#sha256":       {},
		"http://www.w3.org/2001/04/xmldsig-more#sha384": {},
		"http://www.w3.org/2001/04/xmlenc#sha512":       {},
	}
	if _, ok := allowedDigests[digest.SelectAttrValue("Algorithm", "")]; !ok {
		return errors.New("SAML digest algorithm is not allowed")
	}
	transforms := references[0].FindElements("./Transforms/Transform")
	enveloped := 0
	for _, transform := range transforms {
		algorithm := transform.SelectAttrValue("Algorithm", "")
		switch algorithm {
		case "http://www.w3.org/2000/09/xmldsig#enveloped-signature":
			enveloped++
		case "http://www.w3.org/2001/10/xml-exc-c14n#", "http://www.w3.org/2006/12/xml-c14n11":
		default:
			return errors.New("SAML signature transform is not allowed")
		}
	}
	if enveloped != 1 || len(transforms) < 1 || len(transforms) > 2 {
		return errors.New("SAML signature transforms are invalid")
	}
	if signature.FindElement("./SignatureValue") == nil {
		return errors.New("SAML signature value is missing")
	}
	return nil
}

func collectSAMLIDs(root *etree.Element) map[string]int {
	ids := map[string]int{}
	var visit func(*etree.Element)
	visit = func(element *etree.Element) {
		if attr := element.SelectAttr("ID"); attr != nil {
			ids[attr.Value]++
		}
		for _, child := range element.ChildElements() {
			visit(child)
		}
	}
	visit(root)
	return ids
}
