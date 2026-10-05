package httpapi

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/beevik/etree"
	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authn"
	"github.com/crewjam/saml"
	dsig "github.com/russellhaering/goxmldsig"
)

const (
	testSAMLIssuer  = "https://idp.example.test/tenant"
	testSAMLEntity  = "https://api.example.test/saml/metadata"
	testSAMLACS     = "https://api.example.test/api/auth/callback/saml"
	testSAMLRequest = "id-request-0123456789abcdef"
)

func TestValidateSAMLResponseVerifiesPinnedSignaturesAndClaims(t *testing.T) {
	key, cert, certPEM := makeSAMLTestCertificate(t)
	raw := makeSignedSAMLResponse(t, key, cert, testSAMLIssuer, testSAMLACS, testSAMLRequest, testSAMLEntity, time.Now().UTC(), true, false)
	acs, _ := url.Parse(testSAMLACS)
	sp := makeTestSAMLServiceProvider(t, certPEM)
	claims, err := validateSAMLResponse(raw, testSAMLRequest, sp, *acs, testSAMLIssuer, "email", "displayName", cert, time.Now().UTC())
	if err != nil {
		t.Fatalf("valid signed SAML response rejected: %v", err)
	}
	if claims.Issuer != testSAMLIssuer || claims.Subject != "subject-123" || claims.Email != "alice@example.test" || claims.Name != "Alice Example" || claims.ResponseID != "response-123" || claims.AssertionID != "assertion-123" {
		t.Fatalf("unexpected verified claims: %+v", claims)
	}
}

func TestValidateSAMLResponseRejectsSignedAssertionWithoutIssuer(t *testing.T) {
	key, cert, certPEM := makeSAMLTestCertificate(t)
	raw := makeSignedSAMLResponse(t, key, cert, testSAMLIssuer, testSAMLACS, testSAMLRequest, testSAMLEntity, time.Now().UTC(), true, false)
	doc := etree.NewDocument()
	if err := doc.ReadFromBytes(raw); err != nil {
		t.Fatal(err)
	}
	root := doc.Root()
	assertion := root.FindElement("./Assertion")
	issuer := assertion.FindElement("./Issuer")
	if assertion == nil || issuer == nil {
		t.Fatal("signed fixture is missing expected assertion structure")
	}
	assertion.RemoveChild(issuer)
	root.RemoveChild(root.FindElement("./Signature"))
	*root = *signSAMLFixtureElement(t, root, key, cert)
	raw, err := doc.WriteToBytes()
	if err != nil {
		t.Fatal(err)
	}
	acs, _ := url.Parse(testSAMLACS)
	if _, err := validateSAMLResponse(raw, testSAMLRequest, makeTestSAMLServiceProvider(t, certPEM), *acs, testSAMLIssuer, "email", "displayName", cert, time.Now().UTC()); err == nil {
		t.Fatal("signed SAML assertion without an issuer was accepted")
	}
}

func TestSAMLAssertionIssuerGuardHandlesNilPointer(t *testing.T) {
	var issuer *saml.Issuer
	if value, ok := samlAssertionIssuer(issuer); ok || value != "" {
		t.Fatalf("nil assertion issuer accepted: value=%q ok=%v", value, ok)
	}
}

func TestValidateSAMLResponseRejectsWrongPinnedSigningCertificate(t *testing.T) {
	key, _, _ := makeSAMLTestCertificate(t)
	_, pinnedCert, certPEM := makeSAMLTestCertificate(t)
	raw := makeSignedSAMLResponse(t, key, nil, testSAMLIssuer, testSAMLACS, testSAMLRequest, testSAMLEntity, time.Now().UTC(), true, false)
	acs, _ := url.Parse(testSAMLACS)
	sp := makeTestSAMLServiceProvider(t, certPEM)
	if _, err := validateSAMLResponse(raw, testSAMLRequest, sp, *acs, testSAMLIssuer, "email", "displayName", pinnedCert, time.Now().UTC()); err == nil {
		t.Fatal("response signed by a non-pinned key was accepted")
	}
}

func TestValidateSAMLResponseRejectsWeakAlgorithmsAndWrappedReferences(t *testing.T) {
	key, cert, certPEM := makeSAMLTestCertificate(t)
	acs, _ := url.Parse(testSAMLACS)
	for _, test := range []struct {
		name   string
		mutate func(*etree.Element)
	}{
		{name: "sha1 signature", mutate: func(signature *etree.Element) {
			signature.FindElement("./SignedInfo/SignatureMethod").SelectAttr("Algorithm").Value = "http://www.w3.org/2000/09/xmldsig#rsa-sha1"
		}},
		{name: "wrong signed reference", mutate: func(signature *etree.Element) {
			signature.FindElement("./SignedInfo/Reference").SelectAttr("URI").Value = "#assertion-123"
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			raw := makeSignedSAMLResponse(t, key, cert, testSAMLIssuer, testSAMLACS, testSAMLRequest, testSAMLEntity, time.Now().UTC(), true, false)
			doc := etree.NewDocument()
			if err := doc.ReadFromBytes(raw); err != nil {
				t.Fatal(err)
			}
			test.mutate(doc.Root().FindElement("./Signature"))
			mutated, err := doc.WriteToBytes()
			if err != nil {
				t.Fatal(err)
			}
			if _, err := validateSAMLResponse(mutated, testSAMLRequest, makeTestSAMLServiceProvider(t, certPEM), *acs, testSAMLIssuer, "email", "displayName", cert, time.Now().UTC()); err == nil {
				t.Fatal("weak or ambiguous XML signature was accepted")
			}
		})
	}
}

func TestValidateSAMLResponseRejectsProtocolAndAssertionBoundaryFailures(t *testing.T) {
	key, cert, certPEM := makeSAMLTestCertificate(t)
	acs, _ := url.Parse(testSAMLACS)
	for _, test := range []struct {
		name  string
		build func() []byte
	}{
		{name: "wrong destination", build: func() []byte {
			return makeSignedSAMLResponse(t, key, cert, testSAMLIssuer, "https://attacker.example.test/acs", testSAMLRequest, testSAMLEntity, time.Now().UTC(), true, false)
		}},
		{name: "wrong response correlation", build: func() []byte {
			return makeSignedSAMLResponse(t, key, cert, testSAMLIssuer, testSAMLACS, "id-other-request", testSAMLEntity, time.Now().UTC(), true, false)
		}},
		{name: "wrong audience", build: func() []byte {
			return makeSignedSAMLResponse(t, key, cert, testSAMLIssuer, testSAMLACS, testSAMLRequest, "https://other.example.test/sp", time.Now().UTC(), true, false)
		}},
		{name: "expired assertion", build: func() []byte {
			return makeSignedSAMLResponse(t, key, cert, testSAMLIssuer, testSAMLACS, testSAMLRequest, testSAMLEntity, time.Now().UTC().Add(-time.Hour), true, false)
		}},
		{name: "unsigned response", build: func() []byte {
			return makeSignedSAMLResponse(t, key, cert, testSAMLIssuer, testSAMLACS, testSAMLRequest, testSAMLEntity, time.Now().UTC(), false, false)
		}},
		{name: "multiple assertions", build: func() []byte {
			return makeSignedSAMLResponse(t, key, cert, testSAMLIssuer, testSAMLACS, testSAMLRequest, testSAMLEntity, time.Now().UTC(), true, true)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			sp := makeTestSAMLServiceProvider(t, certPEM)
			if _, err := validateSAMLResponse(test.build(), testSAMLRequest, sp, *acs, testSAMLIssuer, "email", "displayName", cert, time.Now().UTC()); err == nil {
				t.Fatal("invalid SAML response was accepted")
			}
		})
	}
}

func TestParseSAMLTrustConfigurationRejectsUnpinnedOrInsecureValues(t *testing.T) {
	_, _, certPEM := makeSAMLTestCertificate(t)
	base := SAMLConfig{
		IDPIssuer: testSAMLIssuer, IDPSSOURL: "https://idp.example.test/sso", IDPSigningCertPEM: certPEM,
		SPEntityID: testSAMLEntity, ACSURL: testSAMLACS, SuccessURL: "https://app.example.test/",
		TrustVerifiedEmail: true, EmailAttribute: "email", NameAttribute: "displayName",
	}
	if handler, err := NewSAMLSignInHandler(new(authn.Service), strings.Repeat("x", 32), true, nil, base); err != nil || handler == nil {
		t.Fatalf("valid pinned SAML configuration rejected: handler=%v err=%v", handler, err)
	}
	for _, mutate := range []func(*SAMLConfig){
		func(c *SAMLConfig) { c.IDPSSOURL = "http://idp.example.test/sso" },
		func(c *SAMLConfig) { c.IDPSigningCertPEM = "" },
		func(c *SAMLConfig) { c.ACSURL += "?next=https://attacker.example.test" },
		func(c *SAMLConfig) { c.TrustVerifiedEmail = false },
		func(c *SAMLConfig) { c.EmailAttribute = " " },
		func(c *SAMLConfig) { c.ACSURL = "http://api.example.test/api/auth/callback/saml" },
	} {
		config := base
		mutate(&config)
		if _, err := NewSAMLSignInHandler(new(authn.Service), strings.Repeat("x", 32), true, nil, config); err == nil {
			t.Fatal("invalid or untrusted SAML configuration was accepted")
		}
	}
}

func TestFederatedAuthComposerMountsSAMLWithoutReplacingExistingAuthRoutes(t *testing.T) {
	samlRoutes := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-SAML-Route", r.Method+" "+r.URL.Path)
	})
	handler, err := NewAuthHandlerWithFederatedRoutes(new(authn.Service), strings.Repeat("x", 32), true, nil, nil, nil, samlRoutes)
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/sign-in/saml"},
		{http.MethodPost, "/callback/saml"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(route.method, route.path, nil))
		if response.Header().Get("X-SAML-Route") != route.method+" "+route.path {
			t.Fatalf("SAML route was not composed: %s %s, response=%v", route.method, route.path, response.Header())
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/get-session", nil))
	if response.Code != http.StatusOK || strings.TrimSpace(response.Body.String()) != "null" {
		t.Fatalf("existing Go auth route was replaced, status=%d body=%s", response.Code, response.Body.String())
	}
}

func makeTestSAMLServiceProvider(t *testing.T, certPEM string) *saml.ServiceProvider {
	t.Helper()
	acs, err := url.Parse(testSAMLACS)
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode([]byte(certPEM))
	trustedCertificate := base64.StdEncoding.EncodeToString(block.Bytes)
	return &saml.ServiceProvider{
		EntityID: testSAMLEntity, AcsURL: *acs,
		IDPMetadata:    &saml.EntityDescriptor{EntityID: testSAMLIssuer},
		IDPCertificate: &trustedCertificate,
		ValidateAudienceRestriction: func(assertion *saml.Assertion) error {
			if assertion == nil || assertion.Conditions == nil || len(assertion.Conditions.AudienceRestrictions) == 0 {
				return fmt.Errorf("audience restriction missing")
			}
			for _, restriction := range assertion.Conditions.AudienceRestrictions {
				if restriction.Audience.Value != testSAMLEntity {
					return fmt.Errorf("wrong audience")
				}
			}
			return nil
		},
	}
}

func makeSAMLTestCertificate(t *testing.T) (*rsa.PrivateKey, *x509.Certificate, string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	template := &x509.Certificate{
		SerialNumber: big.NewInt(now.UnixNano()), Subject: pkix.Name{CommonName: "SAML fixture IdP"},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return key, cert, string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

func makeSignedSAMLResponse(t *testing.T, key *rsa.PrivateKey, cert *x509.Certificate, issuer, destination, inResponseTo, audience string, now time.Time, signResponse, duplicateAssertion bool) []byte {
	t.Helper()
	if cert == nil {
		_, cert, _ = makeSAMLTestCertificate(t)
	}
	notBefore := now.Add(-time.Minute).UTC().Format(time.RFC3339)
	notAfter := now.Add(time.Minute).UTC().Format(time.RFC3339)
	issue := now.UTC().Format(time.RFC3339)
	assertion := fmt.Sprintf(`<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="assertion-123" Version="2.0" IssueInstant="%s"><saml:Issuer>%s</saml:Issuer><saml:Subject><saml:NameID>subject-123</saml:NameID><saml:SubjectConfirmation Method="%s"><saml:SubjectConfirmationData Recipient="%s" InResponseTo="%s" NotOnOrAfter="%s"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="%s" NotOnOrAfter="%s"><saml:AudienceRestriction><saml:Audience>%s</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>alice@example.test</saml:AttributeValue></saml:Attribute><saml:Attribute Name="displayName"><saml:AttributeValue>Alice Example</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion>`, issue, issuer, samlBearerMethod, destination, inResponseTo, notAfter, notBefore, notAfter, audience)
	duplicate := ""
	if duplicateAssertion {
		duplicate = strings.Replace(assertion, `ID="assertion-123"`, `ID="assertion-456"`, 1)
	}
	xmlText := fmt.Sprintf(`<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="response-123" Version="2.0" IssueInstant="%s" Destination="%s" InResponseTo="%s"><saml:Issuer>%s</saml:Issuer><samlp:Status><samlp:StatusCode Value="%s"/></samlp:Status>%s%s</samlp:Response>`, issue, destination, inResponseTo, issuer, saml.StatusSuccess, assertion, duplicate)
	doc := etree.NewDocument()
	if err := doc.ReadFromString(xmlText); err != nil {
		t.Fatal(err)
	}
	root := doc.Root()
	if signResponse {
		signed := signSAMLFixtureElement(t, root, key, cert)
		*root = *signed
	} else {
		assertionEl := root.FindElement("./Assertion")
		if assertionEl == nil {
			t.Fatal("fixture assertion not found")
		}
		signed := signSAMLFixtureElement(t, assertionEl, key, cert)
		root.RemoveChild(assertionEl)
		root.AddChild(signed)
	}
	encoded, err := doc.WriteToBytes()
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func signSAMLFixtureElement(t *testing.T, element *etree.Element, key *rsa.PrivateKey, cert *x509.Certificate) *etree.Element {
	t.Helper()
	context, err := dsig.NewSigningContext(key, [][]byte{cert.Raw})
	if err != nil {
		t.Fatal(err)
	}
	if err := context.SetSignatureMethod(dsig.RSASHA256SignatureMethod); err != nil {
		t.Fatal(err)
	}
	signed, err := context.SignEnveloped(element)
	if err != nil {
		t.Fatal(err)
	}
	return signed
}

func TestSAMLResponseFormSizeLimit(t *testing.T) {
	if base64.StdEncoding.EncodedLen(samlBodyLimit)+1024 <= samlBodyLimit {
		t.Fatal("SAML base64 limit must account for encoding expansion")
	}
}
