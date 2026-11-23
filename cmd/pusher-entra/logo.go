package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
)

// MaxLogoBytes is the largest logo the hub keeps as a custom icon.
const MaxLogoBytes = 256 << 10

// Logo fetches an app's logo and says its type, when it is one the hub
// keeps (PNG or WebP). Entra serves logos from a public CDN, so no token is
// sent.
func Logo(ctx context.Context, client *http.Client, raw string) (data []byte, contentType string, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, "", err
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("logo: %d", res.StatusCode)
	}
	data, err = io.ReadAll(io.LimitReader(res.Body, MaxLogoBytes+1))
	if err != nil {
		return nil, "", err
	}
	if len(data) > MaxLogoBytes {
		return nil, "", fmt.Errorf("logo: larger than %d bytes", MaxLogoBytes)
	}
	return data, ImageType(data), nil
}

// ImageType is the type of a PNG or WebP image by its magic bytes, or empty
// for anything else.
func ImageType(data []byte) string {
	switch {
	case bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")):
		return "image/png"
	case len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		return "image/webp"
	}
	return ""
}
