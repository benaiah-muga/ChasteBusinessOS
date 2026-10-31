package authn

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"strings"
	"unicode/utf16"

	"golang.org/x/crypto/scrypt"
	"golang.org/x/text/unicode/norm"
)

const (
	passwordScryptN   = 1 << 14
	passwordScryptR   = 16
	passwordScryptP   = 1
	passwordKeyBytes  = 64
	passwordSaltBytes = 16
	minPasswordLength = 8
	maxPasswordLength = 128
)

var errInvalidPasswordHash = errors.New("invalid password hash")

func hmacSHA256(key, message []byte) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(message)
	return mac.Sum(nil)
}

// PasswordLength counts UTF-16 code units because Better Auth 1.7.1 validates
// JavaScript string.length, not UTF-8 bytes or Unicode code points.
func PasswordLength(value string) int { return len(utf16.Encode([]rune(value))) }

// HashPassword writes Better Auth 1.7.1's default credential format exactly:
// scrypt(N=16384,r=16,p=1,dkLen=64), with NFKC-normalized input and a 16-byte
// random salt encoded as hexadecimal and then used as UTF-8 salt bytes.
func HashPassword(password string) (string, error) {
	var saltBytes [passwordSaltBytes]byte
	if _, err := rand.Read(saltBytes[:]); err != nil {
		return "", err
	}
	salt := hex.EncodeToString(saltBytes[:])
	key, err := scrypt.Key([]byte(norm.NFKC.String(password)), []byte(salt), passwordScryptN, passwordScryptR, passwordScryptP, passwordKeyBytes)
	if err != nil {
		return "", err
	}
	return salt + ":" + hex.EncodeToString(key), nil
}

// VerifyPassword accepts the exact hash representation persisted by Better
// Auth 1.7.1 and compares the derived key in constant time.
func VerifyPassword(encoded, password string) (bool, error) {
	salt, keyHex, ok := strings.Cut(encoded, ":")
	if !ok || salt == "" || keyHex == "" || strings.Contains(keyHex, ":") {
		return false, errInvalidPasswordHash
	}
	expected, err := hex.DecodeString(keyHex)
	if err != nil || len(expected) != passwordKeyBytes {
		return false, errInvalidPasswordHash
	}
	actual, err := scrypt.Key([]byte(norm.NFKC.String(password)), []byte(salt), passwordScryptN, passwordScryptR, passwordScryptP, passwordKeyBytes)
	if err != nil {
		return false, err
	}
	return subtle.ConstantTimeCompare(actual, expected) == 1, nil
}
