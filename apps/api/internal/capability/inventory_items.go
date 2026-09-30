package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

const (
	inventoryCreateItemCapabilityID          = "inventory.createItem"
	inventoryUpdateItemCapabilityID          = "inventory.updateItem"
	inventoryRestoreItemCapabilityID         = "inventory.restoreItem"
	inventoryArchiveItemCapabilityID         = "inventory.archiveItem"
	inventoryCreateLocationCapabilityID      = "inventory.createLocation"
	inventoryListLocationsCapabilityID       = "inventory.listLocations"
	inventoryListLocationRecordsCapabilityID = "inventory.listLocationRecords"
	inventoryLookupByBarcodeCapabilityID     = "inventory.lookupByBarcode"
)

type InventoryCreateItemInput struct {
	SKU                     string   `json:"sku"`
	Name                    string   `json:"name"`
	Kind                    string   `json:"kind"`
	UnitLabel               string   `json:"unitLabel"`
	SalePriceMinor          int64    `json:"salePriceMinor"`
	ReorderPointThousandths int64    `json:"reorderPointThousandths"`
	ImageURL                *string  `json:"imageUrl,omitempty"`
	Tags                    []string `json:"tags"`
	Barcode                 *string  `json:"barcode,omitempty"`
}

type InventoryCreateItemOutput struct {
	ItemID string `json:"itemId"`
}

// InventoryItemPatchInput keeps the zod patch semantics: a field that is
// absent is left untouched, while an explicitly null barcode or imageUrl
// clears it. Name, unitLabel, salePriceMinor, and tags reject null because
// the TS schema does not mark them nullable.
type InventoryItemPatchInput struct {
	SKU            string    `json:"-"`
	Name           *string   `json:"-"`
	UnitLabel      *string   `json:"-"`
	SalePriceMinor *int64    `json:"-"`
	ImageURL       *string   `json:"-"`
	ImageURLSet    bool      `json:"-"`
	Tags           *[]string `json:"-"`
	Barcode        *string   `json:"-"`
	BarcodeSet     bool      `json:"-"`
}

func (input InventoryItemPatchInput) MarshalJSON() ([]byte, error) {
	value := map[string]any{"sku": input.SKU}
	if input.Name != nil {
		value["name"] = *input.Name
	}
	if input.UnitLabel != nil {
		value["unitLabel"] = *input.UnitLabel
	}
	if input.SalePriceMinor != nil {
		value["salePriceMinor"] = *input.SalePriceMinor
	}
	if input.ImageURLSet {
		value["imageUrl"] = input.ImageURL
	}
	if input.Tags != nil {
		value["tags"] = *input.Tags
	}
	if input.BarcodeSet {
		value["barcode"] = input.Barcode
	}
	return json.Marshal(value)
}

// InventoryItemPrior snapshots the pre-patch values of exactly the patched
// fields; it is what inventory.restoreItem replays to undo an update.
type InventoryItemPrior struct {
	SKU               string   `json:"-"`
	NameSet           bool     `json:"-"`
	Name              *string  `json:"-"`
	UnitLabelSet      bool     `json:"-"`
	UnitLabel         *string  `json:"-"`
	SalePriceMinorSet bool     `json:"-"`
	SalePriceMinor    *int64   `json:"-"`
	ImageURLSet       bool     `json:"-"`
	ImageURL          *string  `json:"-"`
	TagsSet           bool     `json:"-"`
	Tags              []string `json:"-"`
	BarcodeSet        bool     `json:"-"`
	Barcode           *string  `json:"-"`
}

func (prior InventoryItemPrior) MarshalJSON() ([]byte, error) {
	value := map[string]any{"sku": prior.SKU}
	if prior.NameSet {
		value["name"] = prior.Name
	}
	if prior.UnitLabelSet {
		value["unitLabel"] = prior.UnitLabel
	}
	if prior.SalePriceMinorSet {
		value["salePriceMinor"] = prior.SalePriceMinor
	}
	if prior.ImageURLSet {
		value["imageUrl"] = prior.ImageURL
	}
	if prior.TagsSet {
		value["tags"] = prior.Tags
	}
	if prior.BarcodeSet {
		value["barcode"] = prior.Barcode
	}
	return json.Marshal(value)
}

type InventoryUpdateItemOutput struct {
	SKU   string             `json:"sku"`
	Prior InventoryItemPrior `json:"prior"`
}

type InventoryArchiveItemInput struct {
	SKU     string `json:"sku"`
	Archive bool   `json:"archive"`
}

type InventoryArchiveItemOutput struct {
	SKU      string `json:"sku"`
	Archived bool   `json:"archived"`
}

type InventoryCreateLocationInput struct {
	Code string `json:"code"`
	Name string `json:"name"`
}

type InventoryCreateLocationOutput struct {
	LocationID string `json:"locationId"`
}

type InventoryListLocationsInput struct{}

type InventoryListLocationRow struct {
	Code string `json:"code"`
	Name string `json:"name"`
}

type InventoryListLocationsOutput struct {
	Locations []InventoryListLocationRow `json:"locations"`
}

type InventoryListLocationRecordsInput struct{}

type InventoryLocationRecordRow struct {
	ID        string `json:"id"`
	OrgID     string `json:"orgId"`
	Code      string `json:"code"`
	Name      string `json:"name"`
	CreatedAt string `json:"createdAt"`
}

type InventoryListLocationRecordsOutput struct {
	Locations []InventoryLocationRecordRow `json:"locations"`
}

type InventoryLookupByBarcodeInput struct {
	Barcode string `json:"barcode"`
}

type InventoryBarcodeItem struct {
	ID        string   `json:"id"`
	SKU       string   `json:"sku"`
	Name      string   `json:"name"`
	UnitLabel string   `json:"unitLabel"`
	ImageURL  *string  `json:"imageUrl"`
	Tags      []string `json:"tags"`
}

type InventoryLookupByBarcodeOutput struct {
	Item *InventoryBarcodeItem `json:"item"`
}

func parseInventoryItemInput(capabilityID string, raw json.RawMessage) (any, error) {
	switch capabilityID {
	case inventoryCreateItemCapabilityID:
		return ParseInventoryCreateItemInput(raw)
	case inventoryUpdateItemCapabilityID, inventoryRestoreItemCapabilityID:
		return ParseInventoryItemPatchInput(raw)
	case inventoryArchiveItemCapabilityID:
		return ParseInventoryArchiveItemInput(raw)
	case inventoryCreateLocationCapabilityID:
		return ParseInventoryCreateLocationInput(raw)
	case inventoryListLocationsCapabilityID:
		return ParseInventoryListLocationsInput(raw)
	case inventoryListLocationRecordsCapabilityID:
		return ParseInventoryListLocationRecordsInput(raw)
	case inventoryLookupByBarcodeCapabilityID:
		return ParseInventoryLookupByBarcodeInput(raw)
	default:
		return nil, errors.New("unsupported inventory item capability")
	}
}

// inventoryZodURL mirrors zod's z.string().url(), which accepts exactly the
// values the WHATWG URL constructor accepts: a scheme is mandatory and the
// special schemes additionally require a host.
func inventoryZodURL(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil {
		return false
	}
	if parsed.Scheme == "" {
		return false
	}
	switch strings.ToLower(parsed.Scheme) {
	case "file":
		return true
	case "http", "https", "ws", "wss", "ftp":
		return parsed.Host != ""
	}
	return true
}

func inventoryItemURLField(raw json.RawMessage, nullable bool) (*string, bool, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		if !nullable {
			return nil, false, errors.New("imageUrl must be a string")
		}
		return nil, true, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, false, errors.New("imageUrl must be a string")
	}
	if !inventoryZodURL(value) {
		return nil, false, errors.New("imageUrl must be a URL")
	}
	if utf16Length(value) > 500 {
		return nil, false, errors.New("imageUrl must be at most 500 characters")
	}
	return &value, true, nil
}

func inventoryItemBarcodeField(raw json.RawMessage, nullable bool) (*string, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		if !nullable {
			return nil, errors.New("barcode must be a string")
		}
		return nil, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, errors.New("barcode must be a string")
	}
	if length := utf16Length(value); length < 3 || length > 64 {
		return nil, errors.New("barcode must contain between 3 and 64 characters")
	}
	return &value, nil
}

func inventoryItemOptionalTags(fields map[string]json.RawMessage, key string) ([]string, bool, error) {
	raw, ok := fields[key]
	if !ok {
		return nil, false, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, false, fmt.Errorf("%s must be an array", key)
	}
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil || values == nil {
		return nil, false, fmt.Errorf("%s must be an array", key)
	}
	if len(values) > 20 {
		return nil, false, fmt.Errorf("%s must contain at most 20 items", key)
	}
	tags := make([]string, 0, len(values))
	for _, rawTag := range values {
		var tag string
		if err := json.Unmarshal(rawTag, &tag); err != nil {
			return nil, false, errors.New("each tag must be a string")
		}
		if length := utf16Length(tag); length < 1 || length > 30 {
			return nil, false, errors.New("each tag must contain between 1 and 30 characters")
		}
		tags = append(tags, tag)
	}
	return tags, true, nil
}

// inventoryItemNonNegativeInt mirrors zod's defaulted z.number().int()
// fields: absent takes the default, null and non-integer spellings such as
// "5" are refused, and negatives are refused.
func inventoryItemNonNegativeInt(fields map[string]json.RawMessage, key string, defaultValue int64) (int64, error) {
	raw, ok := fields[key]
	if !ok {
		return defaultValue, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return 0, fmt.Errorf("%s must be an integer", key)
	}
	if bytes.HasPrefix(bytes.TrimSpace(raw), []byte(`"`)) {
		return 0, fmt.Errorf("%s must be an integer", key)
	}
	value, err := requiredSafeInteger(fields, key)
	if err != nil {
		return 0, err
	}
	if value < 0 {
		return 0, fmt.Errorf("%s must be a nonnegative integer", key)
	}
	return value, nil
}

func ParseInventoryCreateItemInput(raw json.RawMessage) (InventoryCreateItemInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryCreateItemInput{}, err
	}
	var input InventoryCreateItemInput
	if input.SKU, err = requiredCRMDealString(fields, "sku", 1, 40); err != nil {
		return InventoryCreateItemInput{}, err
	}
	if input.Name, err = requiredCRMDealString(fields, "name", 1, 120); err != nil {
		return InventoryCreateItemInput{}, err
	}
	input.Kind = "goods"
	if _, ok := fields["kind"]; ok {
		kind, err := projectRequiredEnum(fields, "kind", []string{"goods", "service"})
		if err != nil {
			return InventoryCreateItemInput{}, err
		}
		input.Kind = kind
	}
	input.UnitLabel = "unit"
	if input.UnitLabel, err = inventoryItemStringWithDefault(fields, "unitLabel", input.UnitLabel, 20); err != nil {
		return InventoryCreateItemInput{}, err
	}
	if input.SalePriceMinor, err = inventoryItemNonNegativeInt(fields, "salePriceMinor", 0); err != nil {
		return InventoryCreateItemInput{}, err
	}
	if input.ReorderPointThousandths, err = inventoryItemNonNegativeInt(fields, "reorderPointThousandths", 0); err != nil {
		return InventoryCreateItemInput{}, err
	}
	if rawImage, ok := fields["imageUrl"]; ok {
		value, _, err := inventoryItemURLField(rawImage, false)
		if err != nil {
			return InventoryCreateItemInput{}, err
		}
		input.ImageURL = value
	}
	input.Tags = []string{}
	if tags, present, err := inventoryItemOptionalTags(fields, "tags"); err != nil {
		return InventoryCreateItemInput{}, err
	} else if present {
		input.Tags = tags
	}
	if rawBarcode, ok := fields["barcode"]; ok {
		value, err := inventoryItemBarcodeField(rawBarcode, false)
		if err != nil {
			return InventoryCreateItemInput{}, err
		}
		input.Barcode = value
	}
	return input, nil
}

func inventoryItemStringWithDefault(fields map[string]json.RawMessage, key, defaultValue string, maxLength int) (string, error) {
	if _, ok := fields[key]; !ok {
		return defaultValue, nil
	}
	value, err := optionalCRMDealString(fields, key, maxLength, false)
	if err != nil {
		return "", err
	}
	if value == nil {
		return "", fmt.Errorf("%s must be a string", key)
	}
	return *value, nil
}

func ParseInventoryItemPatchInput(raw json.RawMessage) (InventoryItemPatchInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryItemPatchInput{}, err
	}
	var input InventoryItemPatchInput
	if input.SKU, err = requiredCRMDealString(fields, "sku", 1, 0); err != nil {
		return InventoryItemPatchInput{}, err
	}
	if rawName, ok := fields["name"]; ok {
		value, err := readOptionalString(rawName)
		if err != nil {
			return InventoryItemPatchInput{}, errors.New("name must be a string")
		}
		if length := utf16Length(*value); length < 1 || length > 120 {
			return InventoryItemPatchInput{}, errors.New("name must contain between 1 and 120 characters")
		}
		input.Name = value
	}
	if rawUnitLabel, ok := fields["unitLabel"]; ok {
		value, err := readOptionalString(rawUnitLabel)
		if err != nil {
			return InventoryItemPatchInput{}, errors.New("unitLabel must be a string")
		}
		if utf16Length(*value) > 20 {
			return InventoryItemPatchInput{}, errors.New("unitLabel must be at most 20 characters")
		}
		input.UnitLabel = value
	}
	if rawPrice, ok := fields["salePriceMinor"]; ok {
		if bytes.Equal(bytes.TrimSpace(rawPrice), []byte("null")) {
			return InventoryItemPatchInput{}, errors.New("salePriceMinor must be an integer")
		}
		value, err := requiredSafeInteger(fields, "salePriceMinor")
		if err != nil {
			return InventoryItemPatchInput{}, err
		}
		if value < 0 {
			return InventoryItemPatchInput{}, errors.New("salePriceMinor must be a nonnegative integer")
		}
		input.SalePriceMinor = &value
	}
	if rawImage, ok := fields["imageUrl"]; ok {
		value, present, err := inventoryItemURLField(rawImage, true)
		if err != nil {
			return InventoryItemPatchInput{}, err
		}
		input.ImageURL = value
		input.ImageURLSet = present
	}
	if tags, present, err := inventoryItemOptionalTags(fields, "tags"); err != nil {
		return InventoryItemPatchInput{}, err
	} else if present {
		input.Tags = &tags
	}
	if rawBarcode, ok := fields["barcode"]; ok {
		value, err := inventoryItemBarcodeField(rawBarcode, true)
		if err != nil {
			return InventoryItemPatchInput{}, err
		}
		input.Barcode = value
		input.BarcodeSet = true
	}
	return input, nil
}

func ParseInventoryArchiveItemInput(raw json.RawMessage) (InventoryArchiveItemInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryArchiveItemInput{}, err
	}
	sku, err := requiredCRMDealString(fields, "sku", 1, 0)
	if err != nil {
		return InventoryArchiveItemInput{}, err
	}
	input := InventoryArchiveItemInput{SKU: sku, Archive: true}
	if rawArchive, ok := fields["archive"]; ok {
		if bytes.Equal(bytes.TrimSpace(rawArchive), []byte("null")) {
			return InventoryArchiveItemInput{}, errors.New("archive must be a boolean")
		}
		if err := json.Unmarshal(rawArchive, &input.Archive); err != nil {
			return InventoryArchiveItemInput{}, errors.New("archive must be a boolean")
		}
	}
	return input, nil
}

func ParseInventoryCreateLocationInput(raw json.RawMessage) (InventoryCreateLocationInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryCreateLocationInput{}, err
	}
	var input InventoryCreateLocationInput
	if input.Code, err = requiredCRMDealString(fields, "code", 1, 20); err != nil {
		return InventoryCreateLocationInput{}, err
	}
	if input.Name, err = requiredCRMDealString(fields, "name", 1, 80); err != nil {
		return InventoryCreateLocationInput{}, err
	}
	return input, nil
}

func ParseInventoryListLocationsInput(raw json.RawMessage) (InventoryListLocationsInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return InventoryListLocationsInput{}, err
	}
	return InventoryListLocationsInput{}, nil
}

func ParseInventoryListLocationRecordsInput(raw json.RawMessage) (InventoryListLocationRecordsInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return InventoryListLocationRecordsInput{}, err
	}
	return InventoryListLocationRecordsInput{}, nil
}

func ParseInventoryLookupByBarcodeInput(raw json.RawMessage) (InventoryLookupByBarcodeInput, error) {
	fields, err := decodeJSONObject(raw)
	if err != nil {
		return InventoryLookupByBarcodeInput{}, err
	}
	barcode, err := requiredCRMDealString(fields, "barcode", 3, 64)
	if err != nil {
		return InventoryLookupByBarcodeInput{}, err
	}
	return InventoryLookupByBarcodeInput{Barcode: barcode}, nil
}

func inventoryCreateItem(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input InventoryCreateItemInput) (InventoryCreateItemOutput, error) {
	orgID := claims.OrganizationID
	var existingID string
	err := tx.QueryRow(ctx, `
		SELECT id::text FROM items WHERE org_id = $1::uuid AND sku = $2 LIMIT 1`,
		orgID, input.SKU).Scan(&existingID)
	if err == nil {
		return InventoryCreateItemOutput{}, fmt.Errorf("SKU %q already exists", input.SKU)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return InventoryCreateItemOutput{}, err
	}
	if input.Barcode != nil {
		var barcodeOwner string
		err := tx.QueryRow(ctx, `
			SELECT id::text FROM items WHERE org_id = $1::uuid AND barcode = $2 LIMIT 1`,
			orgID, *input.Barcode).Scan(&barcodeOwner)
		if err == nil {
			return InventoryCreateItemOutput{}, fmt.Errorf("barcode %q is already on another item", *input.Barcode)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return InventoryCreateItemOutput{}, err
		}
	}
	// Services never stock: a reorder point on a service is meaningless and
	// would fire phantom alerts, so it is dropped at the boundary.
	reorderPoint := input.ReorderPointThousandths
	if input.Kind == "service" {
		reorderPoint = 0
	}
	tags := input.Tags
	if tags == nil {
		tags = []string{}
	}
	if input.SalePriceMinor > maxDatabaseInteger || reorderPoint > maxDatabaseInteger {
		return InventoryCreateItemOutput{}, errors.New("item amount exceeds the database integer range")
	}
	var itemID string
	err = tx.QueryRow(ctx, `
		INSERT INTO items (org_id, sku, name, kind, unit_label, sale_price_minor, reorder_point_thousandths, image_url, tags, barcode)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
		RETURNING id::text`,
		orgID, input.SKU, input.Name, input.Kind, input.UnitLabel,
		input.SalePriceMinor, reorderPoint, input.ImageURL, tags, input.Barcode).Scan(&itemID)
	if err != nil {
		return InventoryCreateItemOutput{}, err
	}
	return InventoryCreateItemOutput{ItemID: itemID}, nil
}

func inventoryUpdateItem(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input InventoryItemPatchInput) (InventoryUpdateItemOutput, error) {
	return inventoryApplyItemPatch(ctx, tx, claims.OrganizationID, input)
}

func inventoryRestoreItem(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input InventoryItemPatchInput) (InventoryUpdateItemOutput, error) {
	return inventoryApplyItemPatch(ctx, tx, claims.OrganizationID, input)
}

type inventoryItemPatchRow struct {
	id             string
	name           string
	unitLabel      string
	salePriceMinor int64
	imageURL       *string
	tags           []string
	barcode        *string
}

// inventoryApplyItemPatch is the shared command behind updateItem and
// restoreItem: absent fields stay untouched, patched fields overwrite, and
// the prior values of exactly the patched fields come back for undo.
func inventoryApplyItemPatch(ctx context.Context, tx pgx.Tx, orgID string, input InventoryItemPatchInput) (InventoryUpdateItemOutput, error) {
	var record inventoryItemPatchRow
	var rawTags []byte
	err := tx.QueryRow(ctx, `
		SELECT id::text, name, unit_label, sale_price_minor, image_url, tags, barcode
		FROM items WHERE org_id = $1::uuid AND sku = $2 LIMIT 1`, orgID, input.SKU).
		Scan(&record.id, &record.name, &record.unitLabel, &record.salePriceMinor, &record.imageURL, &rawTags, &record.barcode)
	if errors.Is(err, pgx.ErrNoRows) {
		return InventoryUpdateItemOutput{}, fmt.Errorf("no item with SKU %s", input.SKU)
	}
	if err != nil {
		return InventoryUpdateItemOutput{}, err
	}
	if err := json.Unmarshal(rawTags, &record.tags); err != nil {
		return InventoryUpdateItemOutput{}, err
	}
	if input.BarcodeSet && input.Barcode != nil &&
		(record.barcode == nil || *input.Barcode != *record.barcode) {
		var barcodeOwner string
		err := tx.QueryRow(ctx, `
			SELECT id::text FROM items WHERE org_id = $1::uuid AND barcode = $2 LIMIT 1`,
			orgID, *input.Barcode).Scan(&barcodeOwner)
		if err == nil {
			return InventoryUpdateItemOutput{}, fmt.Errorf("barcode %q is already on another item", *input.Barcode)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return InventoryUpdateItemOutput{}, err
		}
	}
	if input.SalePriceMinor != nil && *input.SalePriceMinor > maxDatabaseInteger {
		return InventoryUpdateItemOutput{}, errors.New("salePriceMinor exceeds the database integer range")
	}
	prior := InventoryItemPrior{SKU: input.SKU}
	assignments := make([]string, 0, 6)
	args := make([]any, 0, 8)
	if input.Name != nil {
		assignments = append(assignments, fmt.Sprintf("name = $%d", len(args)+1))
		args = append(args, *input.Name)
		prior.NameSet, prior.Name = true, &record.name
	}
	if input.UnitLabel != nil {
		assignments = append(assignments, fmt.Sprintf("unit_label = $%d", len(args)+1))
		args = append(args, *input.UnitLabel)
		prior.UnitLabelSet, prior.UnitLabel = true, &record.unitLabel
	}
	if input.SalePriceMinor != nil {
		assignments = append(assignments, fmt.Sprintf("sale_price_minor = $%d", len(args)+1))
		args = append(args, *input.SalePriceMinor)
		prior.SalePriceMinorSet, prior.SalePriceMinor = true, &record.salePriceMinor
	}
	if input.ImageURLSet {
		assignments = append(assignments, fmt.Sprintf("image_url = $%d", len(args)+1))
		args = append(args, input.ImageURL)
		prior.ImageURLSet, prior.ImageURL = true, record.imageURL
	}
	if input.Tags != nil {
		assignments = append(assignments, fmt.Sprintf("tags = $%d::jsonb", len(args)+1))
		args = append(args, *input.Tags)
		prior.TagsSet, prior.Tags = true, record.tags
	}
	if input.BarcodeSet {
		assignments = append(assignments, fmt.Sprintf("barcode = $%d", len(args)+1))
		args = append(args, input.Barcode)
		prior.BarcodeSet, prior.Barcode = true, record.barcode
	}
	if len(assignments) == 0 {
		return InventoryUpdateItemOutput{}, errors.New("nothing to update")
	}
	args = append(args, orgID, record.id)
	query := fmt.Sprintf(`UPDATE items SET %s WHERE org_id = $%d::uuid AND id = $%d::uuid`,
		strings.Join(assignments, ", "), len(args)-1, len(args))
	if _, err := tx.Exec(ctx, query, args...); err != nil {
		return InventoryUpdateItemOutput{}, err
	}
	return InventoryUpdateItemOutput{SKU: input.SKU, Prior: prior}, nil
}

func inventoryArchiveItem(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input InventoryArchiveItemInput, now time.Time) (InventoryArchiveItemOutput, error) {
	orgID := claims.OrganizationID
	var itemID string
	err := tx.QueryRow(ctx, `
		SELECT id::text FROM items WHERE org_id = $1::uuid AND sku = $2 LIMIT 1`,
		orgID, input.SKU).Scan(&itemID)
	if errors.Is(err, pgx.ErrNoRows) {
		return InventoryArchiveItemOutput{}, fmt.Errorf("SKU %q not found", input.SKU)
	}
	if err != nil {
		return InventoryArchiveItemOutput{}, err
	}
	var archivedAt any
	if input.Archive {
		archivedAt = now
	}
	if _, err := tx.Exec(ctx, `UPDATE items SET archived_at = $2 WHERE id = $1::uuid`, itemID, archivedAt); err != nil {
		return InventoryArchiveItemOutput{}, err
	}
	return InventoryArchiveItemOutput{SKU: input.SKU, Archived: input.Archive}, nil
}

func inventoryCreateLocation(ctx context.Context, tx pgx.Tx, claims authbridge.CapabilityClaims, input InventoryCreateLocationInput) (InventoryCreateLocationOutput, error) {
	orgID := claims.OrganizationID
	var existingID string
	err := tx.QueryRow(ctx, `
		SELECT id::text FROM stock_locations WHERE org_id = $1::uuid AND code = $2 LIMIT 1`,
		orgID, input.Code).Scan(&existingID)
	if err == nil {
		return InventoryCreateLocationOutput{}, fmt.Errorf("location code %q already exists", input.Code)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return InventoryCreateLocationOutput{}, err
	}
	var locationID string
	err = tx.QueryRow(ctx, `
		INSERT INTO stock_locations (org_id, code, name) VALUES ($1::uuid, $2, $3)
		RETURNING id::text`, orgID, input.Code, input.Name).Scan(&locationID)
	if err != nil {
		return InventoryCreateLocationOutput{}, err
	}
	return InventoryCreateLocationOutput{LocationID: locationID}, nil
}

func inventoryListLocations(ctx context.Context, tx pgx.Tx, orgID string, input InventoryListLocationsInput) (InventoryListLocationsOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT code, name FROM stock_locations WHERE org_id = $1::uuid ORDER BY code ASC`, orgID)
	if err != nil {
		return InventoryListLocationsOutput{}, err
	}
	defer rows.Close()
	locations := make([]InventoryListLocationRow, 0)
	for rows.Next() {
		var location InventoryListLocationRow
		if err := rows.Scan(&location.Code, &location.Name); err != nil {
			return InventoryListLocationsOutput{}, err
		}
		locations = append(locations, location)
	}
	if err := rows.Err(); err != nil {
		return InventoryListLocationsOutput{}, err
	}
	return InventoryListLocationsOutput{Locations: locations}, nil
}

func inventoryListLocationRecords(ctx context.Context, tx pgx.Tx, orgID string, input InventoryListLocationRecordsInput) (InventoryListLocationRecordsOutput, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, org_id::text, code, name, created_at
		FROM stock_locations WHERE org_id = $1::uuid ORDER BY code ASC`, orgID)
	if err != nil {
		return InventoryListLocationRecordsOutput{}, err
	}
	defer rows.Close()
	locations := make([]InventoryLocationRecordRow, 0)
	for rows.Next() {
		var location InventoryLocationRecordRow
		var createdAt time.Time
		if err := rows.Scan(&location.ID, &location.OrgID, &location.Code, &location.Name, &createdAt); err != nil {
			return InventoryListLocationRecordsOutput{}, err
		}
		location.CreatedAt = createdAt.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
		locations = append(locations, location)
	}
	if err := rows.Err(); err != nil {
		return InventoryListLocationRecordsOutput{}, err
	}
	return InventoryListLocationRecordsOutput{Locations: locations}, nil
}

func inventoryLookupByBarcode(ctx context.Context, tx pgx.Tx, orgID string, input InventoryLookupByBarcodeInput) (InventoryLookupByBarcodeOutput, error) {
	var item InventoryBarcodeItem
	var rawTags []byte
	err := tx.QueryRow(ctx, `
		SELECT id::text, sku, name, unit_label, image_url, tags
		FROM items WHERE org_id = $1::uuid AND barcode = $2 LIMIT 1`, orgID, input.Barcode).
		Scan(&item.ID, &item.SKU, &item.Name, &item.UnitLabel, &item.ImageURL, &rawTags)
	if errors.Is(err, pgx.ErrNoRows) {
		return InventoryLookupByBarcodeOutput{Item: nil}, nil
	}
	if err != nil {
		return InventoryLookupByBarcodeOutput{}, err
	}
	if err := json.Unmarshal(rawTags, &item.Tags); err != nil {
		return InventoryLookupByBarcodeOutput{}, err
	}
	return InventoryLookupByBarcodeOutput{Item: &item}, nil
}
