package testenv

import (
	"errors"
	"net/url"
	"os"
)

var ErrDatabaseURLNotConfigured = errors.New("database URL is not configured")

func RuntimeDatabaseURL() (string, error) {
	if runtimeURL := os.Getenv("GO_DATABASE_URL"); runtimeURL != "" {
		return runtimeURL, nil
	}
	ownerURL := os.Getenv("DATABASE_URL")
	if ownerURL == "" {
		if os.Getenv("GO_RUNTIME_INTEGRATION_REQUIRED") == "1" {
			return "", errors.New("GO runtime integration checks require GO_DATABASE_URL or DATABASE_URL")
		}
		return "", ErrDatabaseURLNotConfigured
	}
	parsed, err := url.Parse(ownerURL)
	if err != nil {
		return "", err
	}
	password := os.Getenv("CHASTE_APP_DB_PASSWORD")
	if password == "" {
		password = "chaste_app_dev_only"
	}
	parsed.User = url.UserPassword("chaste_app", password)
	return parsed.String(), nil
}
