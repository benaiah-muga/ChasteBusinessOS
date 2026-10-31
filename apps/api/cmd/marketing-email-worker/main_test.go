package main

import "testing"

func TestMarketingSMTPPort(t *testing.T) {
	for _, test := range []struct {
		value   string
		want    int
		wantErr bool
	}{
		{value: "", want: 587}, {value: "2525", want: 2525},
		{value: "abc", wantErr: true}, {value: "0", wantErr: true}, {value: "65536", wantErr: true},
	} {
		got, err := marketingSMTPPort(test.value)
		if (err != nil) != test.wantErr {
			t.Fatalf("SMTP_PORT %q error=%v", test.value, err)
		}
		if err == nil && got != test.want {
			t.Fatalf("SMTP_PORT %q = %d, want %d", test.value, got, test.want)
		}
	}
}
