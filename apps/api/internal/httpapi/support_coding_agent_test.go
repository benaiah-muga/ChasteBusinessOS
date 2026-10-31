package httpapi

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"net"
	"net/http"
	"testing"
	"time"
)

func TestDecodeSupportOpenCodeCredentialUsesSharedEncryptionFormat(t *testing.T) {
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", "test-only-provider-encryption-secret")
	t.Setenv("BETTER_AUTH_SECRET", "")
	encoded := encryptSupportTestCredential(t, `{"username":"agent","password":"provider-secret"}`)

	credential, err := decodeSupportOpenCodeCredential(encoded)
	if err != nil {
		t.Fatalf("decodeSupportOpenCodeCredential() error = %v", err)
	}
	if credential.Username != "agent" || credential.Password != "provider-secret" {
		t.Fatalf("decoded credential = %#v", credential)
	}
}

func TestDecodeSupportOpenCodeCredentialRejectsUnavailableOrMalformedSecret(t *testing.T) {
	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", "")
	t.Setenv("BETTER_AUTH_SECRET", "")
	if _, err := decodeSupportOpenCodeCredential("v1:bad:bad:bad"); err == nil {
		t.Fatal("expected missing decryption key error")
	}

	t.Setenv("AI_CONFIG_ENCRYPTION_KEY", "test-only-provider-encryption-secret")
	encoded := encryptSupportTestCredential(t, `{"username":"agent"}`)
	if _, err := decodeSupportOpenCodeCredential(encoded); err == nil {
		t.Fatal("expected incomplete OpenCode credentials to fail")
	}
}

func TestResolveSupportOpenCodeEndpointRejectsNonPublicTargets(t *testing.T) {
	for _, endpoint := range []string{
		"http://example.com",
		"https://user:pass@example.com",
		"https://127.0.0.1",
		"https://10.0.0.5",
		"https://service.internal",
		"https://example.com?redirect=1",
	} {
		t.Run(endpoint, func(t *testing.T) {
			if _, _, err := resolveSupportOpenCodeEndpoint(endpoint); err == nil {
				t.Fatalf("resolveSupportOpenCodeEndpoint(%q) unexpectedly succeeded", endpoint)
			}
		})
	}
}

func TestResolveSupportProviderEndpointRejectsUnsafeDestinations(t *testing.T) {
	for _, endpoint := range []string{
		"http://example.com/v1",
		"https://127.0.0.1/v1",
		"https://example.com:8443/v1",
		"https://example.com?next=internal",
	} {
		t.Run(endpoint, func(t *testing.T) {
			if _, _, err := resolveSupportProviderEndpoint(endpoint); err == nil {
				t.Fatalf("resolveSupportProviderEndpoint(%q) unexpectedly succeeded", endpoint)
			}
		})
	}
}

func TestSupportPinnedHTTPClientDoesNotFollowRedirectsOrUseProxy(t *testing.T) {
	client := newSupportPinnedHTTPClient("8.8.8.8", time.Second)
	if client.Transport.(*http.Transport).Proxy != nil {
		t.Fatal("provider client unexpectedly uses environment proxy settings")
	}
	if err := client.CheckRedirect(nil, nil); err != http.ErrUseLastResponse {
		t.Fatalf("redirect policy error = %v, want %v", err, http.ErrUseLastResponse)
	}
}

func TestSupportPublicIPRejectsSpecialUseRanges(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "10.0.0.1", "169.254.1.1", "192.0.2.4", "198.51.100.8", "203.0.113.4", "::1", "fd00::1", "2001:db8::1"} {
		if supportPublicIP(net.ParseIP(address)) {
			t.Errorf("supportPublicIP(%q) = true, want false", address)
		}
	}
	for _, address := range []string{"8.8.8.8", "2606:4700:4700::1111"} {
		if !supportPublicIP(net.ParseIP(address)) {
			t.Errorf("supportPublicIP(%q) = false, want true", address)
		}
	}
}

func TestValidSupportOpenCodeSessionID(t *testing.T) {
	for _, value := range []string{"ses_123-abc", "01234567-89ab-cdef"} {
		if !validSupportOpenCodeSessionID(value) {
			t.Errorf("validSupportOpenCodeSessionID(%q) = false", value)
		}
	}
	for _, value := range []string{"", "../other", "id/other", "id?query", "id%2fother"} {
		if validSupportOpenCodeSessionID(value) {
			t.Errorf("validSupportOpenCodeSessionID(%q) = true", value)
		}
	}
}

func encryptSupportTestCredential(t *testing.T, plaintext string) string {
	t.Helper()
	key := sha256.Sum256([]byte("test-only-provider-encryption-secret"))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		t.Fatal(err)
	}
	sealed := gcm.Seal(nil, nonce, []byte(plaintext), nil)
	tagSize := gcm.Overhead()
	tag := sealed[len(sealed)-tagSize:]
	ciphertext := sealed[:len(sealed)-tagSize]
	return "v1:" + base64.RawURLEncoding.EncodeToString(nonce) + ":" +
		base64.RawURLEncoding.EncodeToString(tag) + ":" +
		base64.RawURLEncoding.EncodeToString(ciphertext)
}
