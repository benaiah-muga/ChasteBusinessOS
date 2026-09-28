package apicontract

import "encoding/json"

// RawJSON keeps open-ended JSON values byte-for-byte compatible with the wire contract.
type RawJSON = json.RawMessage
