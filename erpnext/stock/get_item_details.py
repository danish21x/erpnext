# Copyright (c) 2015, Frappe Technologies Pvt. Ltd. and Contributors
# License: GNU General Public License v3. See license.txt

from __future__ import unicode_literals
import frappe
from frappe import _, throw
from frappe.utils import flt, cint, add_days, cstr, add_months, getdate
import json
from erpnext.accounts.doctype.pricing_rule.pricing_rule import get_pricing_rule_for_item, set_transaction_type
from erpnext.setup.utils import get_exchange_rate
from frappe.model.meta import get_field_precision
from erpnext import get_company_currency
from erpnext.stock.doctype.item.item import get_uom_conv_factor, convert_item_uom_for
from erpnext.setup.doctype.item_default_rule.item_default_rule import get_item_default_values
from erpnext.stock.doctype.price_list.price_list import get_price_list_details
from erpnext.stock.doctype.item_manufacturer.item_manufacturer import get_item_manufacturer_part_no
from erpnext.selling.doctype.sales_commission_category.sales_commission_category import get_commission_rate

from six import string_types, iteritems

sales_doctypes = ['Quotation', 'Sales Order', 'Delivery Note', 'Sales Invoice']
purchase_doctypes = ['Material Request', 'Supplier Quotation', 'Purchase Order', 'Purchase Receipt', 'Purchase Invoice']


@frappe.whitelist()
def get_item_details(args, doc=None, for_validate=False, overwrite_warehouse=True):
	"""
		args = {
			"item_code": "",
			"warehouse": None,
			"customer": "",
			"conversion_rate": 1.0,
			"selling_price_list": None,
			"price_list_currency": None,
			"plc_conversion_rate": 1.0,
			"doctype": "",
			"name": "",
			"supplier": None,
			"transaction_date": None,
			"conversion_rate": 1.0,
			"buying_price_list": None,
			"is_subcontracted": "Yes" / "No",
			"ignore_pricing_rule": 0/1
			"project": ""
			"set_warehouse": ""
		}
	"""

	args = process_args(args)
	item = frappe.get_cached_doc("Item", args.item_code)
	validate_item_details(args, item)

	out = get_basic_details(args, item, overwrite_warehouse)

	if isinstance(doc, string_types):
		doc = json.loads(doc)

	if doc and doc.get('doctype') == 'Purchase Invoice':
		args['bill_date'] = doc.get('bill_date')

	if doc:
		args['posting_date'] = doc.get('posting_date')
		args['transaction_date'] = doc.get('transaction_date') or doc.get('posting_date')

	get_item_tax_template(args, item, out)
	out["item_tax_rate"] = get_item_tax_map(args.company, args.get("item_tax_template") if out.get("item_tax_template") is None \
		else out.get("item_tax_template"), as_json=True)

	get_party_item_code(args, item, out)

	set_valuation_rate(out, args)

	update_party_blanket_order(args, out)

	get_price_list_rate(args, item, out)

	if args.customer and cint(args.is_pos):
		out.update(get_pos_profile_item_details(args.company, args))

	if out.get("warehouse"):
		out.update(get_bin_details(args.item_code, out.warehouse))

	# update args with out, if key or value not exists
	for key, value in iteritems(out):
		if args.get(key) is None:
			args[key] = value

	data = get_pricing_rule_for_item(args, out.price_list_rate,
		doc, for_validate=for_validate)

	out.update(data)

	update_stock(args, out)

	if args.transaction_date and item.lead_time_days:
		out.schedule_date = out.lead_time_date = add_days(args.transaction_date,
			item.lead_time_days)

	if args.get("is_subcontracted") == "Yes":
		out.bom = args.get('bom') or get_default_bom(args.item_code)

	get_gross_profit(out)
	if args.doctype == 'Material Request':
		out.rate = args.rate or out.price_list_rate
		out.amount = flt(args.qty * out.rate)

	return out


def update_stock(args, out):
	if (args.get("doctype") == "Delivery Note" or
		(args.get("doctype") == "Sales Invoice" and args.get('update_stock'))) \
		and out.warehouse and out.stock_qty > 0:

		if out.has_batch_no and not args.get("batch_no"):
			actual_batch_qty = get_batch_qty(out.batch_no, out.warehouse, out.item_code)
			if actual_batch_qty:
				out.update(actual_batch_qty)

		if out.has_serial_no and args.get('batch_no'):
			reserved_so = get_so_reservation_for_item(args)
			out.batch_no = args.get('batch_no')
			out.serial_no = get_serial_no(out, args.serial_no, sales_order=reserved_so)

		elif out.has_serial_no:
			reserved_so = get_so_reservation_for_item(args)
			out.serial_no = get_serial_no(out, args.serial_no, sales_order=reserved_so)


def set_valuation_rate(out, args):
	if frappe.db.exists("Product Bundle", args.item_code, cache=True):
		valuation_rate = 0.0
		bundled_items = frappe.get_doc("Product Bundle", args.item_code)

		for bundle_item in bundled_items.items:
			valuation_rate += \
				flt(get_valuation_rate(bundle_item.item_code, args.company, out.get("warehouse")).get("valuation_rate") \
					* bundle_item.qty)

		out.update({
			"valuation_rate": valuation_rate
		})

	else:
		out.update(get_valuation_rate(args.item_code, args.company, out.get("warehouse"), args.transaction_type_name))


def process_args(args):
	if isinstance(args, string_types):
		args = json.loads(args)

	args = frappe._dict(args)

	if not args.get("price_list"):
		args.price_list = args.get("selling_price_list") or args.get("buying_price_list")

	if args.barcode:
		args.item_code = get_item_code(barcode=args.barcode)
	elif args.vehicle:
		args.item_code = get_item_code(vehicle=args.vehicle)
	elif not args.item_code and args.serial_no:
		args.item_code = get_item_code(serial_no=args.serial_no)

	set_transaction_type(args)
	return args


@frappe.whitelist()
def get_item_code(barcode=None, serial_no=None, vehicle=None):
	if barcode:
		item_code = frappe.db.get_value("Item Barcode", {"barcode": barcode}, fieldname=["parent"])
		if not item_code:
			frappe.throw(_("No Item with Barcode {0}").format(barcode))
	elif vehicle:
		item_code = frappe.db.get_value("Vehicle", vehicle, "item_code")
		if not item_code:
			frappe.throw(_("No Item with Vehicle {0}").format(vehicle))
	elif serial_no:
		item_code = frappe.db.get_value("Serial No", serial_no, "item_code")
		if not item_code:
			frappe.throw(_("No Item with Serial No {0}").format(serial_no))

	return item_code


def validate_item_details(args, item):
	if not args.company:
		throw(_("Please specify Company"))


def get_basic_details(args, item, overwrite_warehouse=True):
	"""
	:param args: {
			"item_code": "",
			"warehouse": None,
			"customer": "",
			"conversion_rate": 1.0,
			"selling_price_list": None,
			"price_list_currency": None,
			"price_list_uom_dependant": None,
			"plc_conversion_rate": 1.0,
			"doctype": "",
			"name": "",
			"supplier": None,
			"transaction_date": None,
			"conversion_rate": 1.0,
			"buying_price_list": None,
			"is_subcontracted": "Yes" / "No",
			"ignore_pricing_rule": 0/1
			"project": "",
			barcode: "",
			serial_no: "",
			currency: "",
			update_stock: "",
			price_list: "",
			company: "",
			order_type: "",
			transaction_type_name: "",
			is_pos: "",
			project: "",
			qty: "",
			stock_qty: "",
			conversion_factor: ""
		}
	:param item: `item_code` of Item object
	:return: frappe._dict
	"""

	if not item:
		item = frappe.get_cached_doc("Item", args.get("item_code"))

	if item.variant_of:
		item.update_template_tables()

	warehouse = get_default_warehouse(item, args, overwrite_warehouse)
	force_default_warehouse = get_force_default_warehouse(item, args)

	if args.get('doctype') == "Material Request" and not args.get('material_request_type'):
		args['material_request_type'] = frappe.db.get_value('Material Request',
			args.get('name'), 'material_request_type', cache=True)

	# Set the UOM to the Default Sales UOM or Default Purchase UOM if configured in the Item Master
	if args.get('doctype') in sales_doctypes:
		default_uom = item.sales_uom if item.sales_uom else item.stock_uom
	elif (args.get('doctype') in ['Purchase Order', 'Purchase Receipt', 'Purchase Invoice']) or \
			(args.get('doctype') == 'Material Request' and args.get('material_request_type') == 'Purchase'):
		default_uom = item.purchase_uom if item.purchase_uom else item.stock_uom
	else:
		default_uom = item.stock_uom

	if not args.get('uom'):
		args.uom = default_uom

	out = frappe._dict({
		"item_code": item.name,
		"item_name": item.item_name,
		"hide_item_code": get_hide_item_code(item, args),
		"description": cstr(item.description).strip(),
		"image": cstr(item.image).strip(),
		"warehouse": warehouse,
		"force_default_warehouse": force_default_warehouse,
		"is_fixed_asset": item.is_fixed_asset,
		"is_stock_item": item.is_stock_item,
		"has_serial_no": item.has_serial_no,
		"has_batch_no": item.has_batch_no,
		"is_vehicle": item.is_vehicle,
		"batch_no": args.get("batch_no") if args.get("batch_no") and frappe.db.get_value("Batch", args.get("batch_no"), 'item') == item.name else "",
		"stock_uom": item.stock_uom,
		"uom": default_uom,
		"min_order_qty": flt(item.min_order_qty) if args.doctype == "Material Request" else "",
		"qty": flt(args.qty) or 1.0,
		"stock_qty": flt(args.qty) or 1.0,
		"price_list_rate": 0.0,
		"base_price_list_rate": 0.0,
		"rate": 0.0,
		"base_rate": 0.0,
		"amount": 0.0,
		"base_amount": 0.0,
		"net_rate": 0.0,
		"net_amount": 0.0,
		"discount_percentage": 0.0,
		"depreciation_percentage": get_depreciation_percentage(item, args),
		"supplier": get_default_supplier(item, args),
		"update_stock": args.get("update_stock") if args.get('doctype') in ['Sales Invoice', 'Purchase Invoice'] else 0,
		"delivered_by_supplier": item.delivered_by_supplier if args.get("doctype") in ["Sales Order", "Sales Invoice"] else 0,
		"weight_per_unit":item.weight_per_unit,
		"weight_uom":item.weight_uom,
		"last_purchase_rate": item.last_purchase_rate if args.get("doctype") in ["Purchase Order"] else 0,
		"transaction_date": args.get("transaction_date"),
		"bill_only_to_customer": get_bill_only_to_customer(item, args),
	})

	out.update(get_item_defaults_details(args))

	if item.get("enable_deferred_revenue") or item.get("enable_deferred_expense"):
		out.update(calculate_service_end_date(args, item))

	# calculate conversion factor
	if item.stock_uom == args.uom:
		out.uom = args.uom
		out.conversion_factor = 1.0
	else:
		conversion = get_conversion_factor(item.name, args.uom)
		if conversion.get('not_convertible'):
			out.uom = default_uom
			out.conversion_factor = flt(get_conversion_factor(item.name, args.uom).get("conversion_factor")) or 1
		else:
			out.uom = args.uom
			out.conversion_factor = flt(conversion.get("conversion_factor"))

	args.conversion_factor = out.conversion_factor
	out.stock_qty = out.qty * out.conversion_factor

	# Contents UOM conversion factor and qty
	out.alt_uom = item.alt_uom
	out.alt_uom_size = item.alt_uom_size if out.alt_uom else 1.0
	out.alt_uom_qty = out.stock_qty * out.alt_uom_size

	# Sales Commission Category
	out.sales_commission_category = get_sales_commission_category(item, args)
	out.commission_rate = get_commission_rate(out.sales_commission_category)

	# calculate last purchase rate
	if args.get('doctype') in purchase_doctypes:
		from erpnext.buying.doctype.purchase_order.purchase_order import item_last_purchase_rate
		out.last_purchase_rate = item_last_purchase_rate(args.name, args.conversion_rate, item.name, out.conversion_factor)

	# if default specified in item is for another company, fetch from company
	for d in [
		["Account", "income_account", "default_income_account"],
		["Account", "expense_account", "default_expense_account"],
		["Cost Center", "cost_center", "cost_center"],
		["Warehouse", "warehouse", ""]]:
			if not out[d[1]]:
				out[d[1]] = frappe.get_cached_value('Company',  args.company,  d[2]) if d[2] else None

	for fieldname in ("item_name", "item_group", "barcodes", "brand", "stock_uom"):
		out[fieldname] = item.get(fieldname)

	if args.get("manufacturer"):
		part_no = get_item_manufacturer_part_no(args.get("item_code"), args.get("manufacturer"))
		if part_no:
			out["manufacturer_part_no"] = part_no
		else:
			out["manufacturer_part_no"] = None
			out["manufacturer"] = None
	else:
		out["manufacturer"] = item.default_item_manufacturer
		out["manufacturer_part_no"] = item.default_manufacturer_part_no

	child_doctype = args.doctype + ' Item'
	meta = frappe.get_meta(child_doctype)
	if meta.get_field("barcode"):
		update_barcode_value(out)

	return out


def get_force_default_warehouse(item, args):
	default_values = get_item_default_values(item, args)
	return cint(default_values.get("force_default_warehouse") == "Yes")


def get_default_warehouse(item, args, overwrite_warehouse=True):
	default_values = get_item_default_values(item, args)
	parent_warehouse = args.get("set_warehouse")

	if overwrite_warehouse or not args.get('warehouse'):
		default_warehouse = default_values.get("default_warehouse") or args.get('warehouse')
		force_default_warehouse = get_force_default_warehouse(item, args)

		if force_default_warehouse:
			warehouse = default_warehouse
		else:
			warehouse = parent_warehouse or default_warehouse

		if not warehouse:
			defaults = frappe.defaults.get_defaults() or {}
			warehouse_exists = frappe.db.exists("Warehouse", {
				'name': defaults.default_warehouse,
				'company': args.get('company')
			})
			if defaults.get("default_warehouse") and warehouse_exists:
				warehouse = defaults.default_warehouse

	else:
		warehouse = args.get('warehouse')

	return warehouse


def update_barcode_value(out):
	from erpnext.accounts.doctype.sales_invoice.pos import get_barcode_data
	barcode_data = get_barcode_data([out])

	# If item has one barcode then update the value of the barcode field
	if barcode_data and len(barcode_data.get(out.item_code)) == 1:
		out['barcode'] = barcode_data.get(out.item_code)[0]


@frappe.whitelist()
def get_item_tax_info(company, tax_category, item_codes):
	out = {}
	if isinstance(item_codes, string_types):
		item_codes = json.loads(item_codes)

	for item_code in item_codes:
		if not item_code or item_code in out:
			continue
		out[item_code] = {}
		item = frappe.get_cached_doc("Item", item_code)
		get_item_tax_template({"tax_category": tax_category}, item, out[item_code])
		out[item_code]["item_tax_rate"] = get_item_tax_map(company, out[item_code].get("item_tax_template"), as_json=True)

	return out


def get_item_tax_template(args, item, out):
	"""
		args = {
			"tax_category": None
			"item_tax_template": None
		}
	"""
	item_tax_template = args.get("item_tax_template")

	if not item_tax_template and item.customs_tariff_number:
		customs_tariff_no_doc = frappe.get_cached_doc("Customs Tariff Number", item.customs_tariff_number)
		item_tax_template = _get_item_tax_template(args, customs_tariff_no_doc.taxes, out)

	if not item_tax_template:
		default_values = get_item_default_values(item, args)
		item_tax_template = _get_item_tax_template(args, default_values.taxes or [], out)


def _get_item_tax_template(args, taxes, out={}, for_validate=False):
	taxes_with_validity = []
	taxes_with_no_validity = []

	for tax in taxes:
		if tax.valid_from:
			# In purchase Invoice first preference will be given to supplier invoice date
			# if supplier date is not present then posting date
			validation_date = args.get('transaction_date') or args.get('bill_date') or args.get('posting_date')

			if getdate(tax.valid_from) <= getdate(validation_date):
				taxes_with_validity.append(tax)
		else:
			taxes_with_no_validity.append(tax)

	if taxes_with_validity:
		taxes = sorted(taxes_with_validity, key = lambda i: i.valid_from, reverse=True)
	else:
		taxes = taxes_with_no_validity

	if for_validate:
		return [tax.item_tax_template for tax in taxes if (cstr(tax.tax_category) == cstr(args.get('tax_category')) \
			and (tax.item_tax_template not in taxes))]

	# all templates have validity and no template is valid
	if not taxes_with_validity and (not taxes_with_no_validity):
		return None

	for tax in taxes:
		if cstr(tax.tax_category) == cstr(args.get("tax_category")):
			out["item_tax_template"] = tax.item_tax_template
			return tax.item_tax_template
	return None


@frappe.whitelist()
def get_item_tax_map(company, item_tax_template, as_json=True):
	item_tax_map = {}
	if item_tax_template:
		template = frappe.get_cached_doc("Item Tax Template", item_tax_template)
		for d in template.taxes:
			if frappe.get_cached_value("Account", d.tax_type, "company") == company:
				item_tax_map[d.tax_type] = d.tax_rate

	return json.dumps(item_tax_map) if as_json else item_tax_map


@frappe.whitelist()
def calculate_service_end_date(args, item=None):
	args = process_args(args)
	if not item:
		item = frappe.get_cached_doc("Item", args.item_code)

	doctype = args.get("parenttype") or args.get("doctype")
	if doctype == "Sales Invoice":
		enable_deferred = "enable_deferred_revenue"
		no_of_months = "no_of_months"
		account = "deferred_revenue_account"
	else:
		enable_deferred = "enable_deferred_expense"
		no_of_months = "no_of_months_exp"
		account = "deferred_expense_account"

	service_start_date = args.service_start_date if args.service_start_date else args.transaction_date
	service_end_date = add_months(service_start_date, item.get(no_of_months))
	deferred_detail = {
		"service_start_date": service_start_date,
		"service_end_date": service_end_date
	}
	deferred_detail[enable_deferred] = item.get(enable_deferred)
	deferred_detail[account] = get_default_deferred_account(args, item, fieldname=account)

	return deferred_detail


def get_default_income_account(item, args):
	default_values = get_item_default_values(item, args)

	account = default_values.get("income_account")
	if not account and args.company:
		account = frappe.get_cached_value("Company", args.company, "default_income_account")

	return account or args.income_account


def get_default_expense_account(item, args):
	default_values = get_item_default_values(item, args)

	account = default_values.get("expense_account")
	if not account and args.company:
		account = frappe.get_cached_value("Company", args.company, "default_expense_account")

	if args.get('doctype') == 'Purchase Invoice' and item.is_fixed_asset:
		from erpnext.assets.doctype.asset_category.asset_category import get_asset_category_account
		account = get_asset_category_account(fieldname="fixed_asset_account", item=args.item_code, company=args.company)

	return account or args.expense_account


def get_default_deferred_account(args, item, fieldname=None):
	if item.get("enable_deferred_revenue") or item.get("enable_deferred_expense"):
		return (item.get(fieldname)
			or args.get(fieldname)
			or frappe.get_cached_value('Company',  args.company,  "default_"+fieldname))
	else:
		return None


def get_default_cost_center(item, args, selling_or_buying=None):
	cost_center = None
	if args.get('project'):
		cost_center = frappe.db.get_value("Project", args.get("project"), "cost_center", cache=True)

	if not cost_center:
		default_values = get_item_default_values(item, args)

		if selling_or_buying == 'selling':
			default_fieldname = 'selling_cost_center'
		elif selling_or_buying == 'buying':
			default_fieldname = 'buying_cost_center'
		elif args.get('doctype') in sales_doctypes or args.get('customer'):
			default_fieldname = 'selling_cost_center'
		else:
			default_fieldname = 'buying_cost_center'

		if default_fieldname:
			cost_center = default_values.get(default_fieldname)

	if not cost_center and args.get('company'):
		cost_center = frappe.get_cached_value("Company", args.get('company'), "cost_center")

	cost_center = cost_center or args.get("cost_center")

	return cost_center


def get_default_supplier(item, args):
	default_values = get_item_default_values(item, args)
	return item.get("default_supplier") or default_values.get("default_supplier")


def get_default_terms(item, args):
	default_values = get_item_default_values(item, args)
	return default_values.get("default_terms")


def get_default_apply_discount_after_taxes(item, args):
	default_values = get_item_default_values(item, args)
	fieldname = "selling_apply_discount_after_taxes" if args.get('doctype') in sales_doctypes or args.get('customer') \
		else "buying_apply_discount_after_taxes"

	apply_discount_after_taxes = default_values.get(fieldname)

	if not apply_discount_after_taxes:
		apply_discount_after_taxes = frappe.get_cached_value("Company", args.company, fieldname)

	return cint(apply_discount_after_taxes == "Yes" if apply_discount_after_taxes else args.get('apply_discount_after_taxes'))


def get_default_allow_zero_valuation_rate(item, args):
	default_values = get_item_default_values(item, args)
	allow_zero_valuation_rate = default_values.get("allow_zero_valuation_rate")
	return cint(allow_zero_valuation_rate == "Yes" if allow_zero_valuation_rate else args.get('allow_zero_valuation_rate'))


def get_target_warehouse_validation(item_code, transaction_type_name, company):
	default_values = get_item_default_values(item_code, {'transaction_type': transaction_type_name, 'company': company})
	return default_values.get("target_warehouse_validation")


def get_hide_item_code(item, args):
	default_values = get_item_default_values(item, args)
	show_item_code = item.get("show_item_code") or default_values.get("show_item_code")
	return cint(show_item_code != "Yes" if show_item_code else args.get('hide_item_code'))


def get_sales_commission_category(item, args):
	default_values = get_item_default_values(item, args)
	return default_values.get('sales_commission_category')


def get_depreciation_percentage(item, args):
	if item.is_stock_item:
		return flt(args.get('default_depreciation_percentage'))
	else:
		return 0


@frappe.whitelist()
def get_item_defaults_info(args, items, set_warehouse=True):
	"""
	:param args: {
		"doctype": "",
		"company": "",
		"transaction_type_name": "",
		"customer": "",
		"supplier": None,
		"project": "",
	}
	:param items: [{
		"name": "",
		"item_code": "",
		"cost_center": "",
		"income_account": "",
		"expense_account": "",
		"allow_zero_valuation_rate": "",
	}, ...]
	:return: dict
	"""

	args = json.loads(args) if isinstance(args, string_types) else args
	items = json.loads(items) if isinstance(items, string_types) else items

	if not args.get('company'):
		return {}

	out = {}
	for d in items:
		if d.get('item_code'):
			item_args = frappe._dict(args)
			item_args.update(d)

			out[d['name']] = get_item_defaults_details(item_args, set_warehouse=set_warehouse)

	return out


def get_item_defaults_details(args, set_warehouse=False):
	"""
	:param args: {
			"doctype": "",
			"company": "",
			"transaction_type_name": "",

			"item_code": "",
			"cost_center": "",
			"income_account": "",
			"expense_account": "",
			"allow_zero_valuation_rate": "",

			"customer": "",
			"supplier": None,
			"project": "",
		}
	:return: dict
	"""

	item = frappe.get_cached_doc("Item", args.get("item_code"))

	out = {
		"income_account": get_default_income_account(item, args),
		"expense_account": get_default_expense_account(item, args),
		"cost_center": get_default_cost_center(item, args),
		"apply_discount_after_taxes": get_default_apply_discount_after_taxes(item, args),
		"allow_zero_valuation_rate": get_default_allow_zero_valuation_rate(item, args),
	}

	if cint(set_warehouse):
		out['warehouse'] = get_default_warehouse(item, args)

	return out


def get_price_list_rate(args, item_doc, out):
	meta = frappe.get_meta(args.parenttype or args.doctype)

	if meta.get_field("currency") or args.get('currency'):
		pl_details = get_price_list_currency_and_exchange_rate(args)
		args.update(pl_details)
		if meta.get_field("currency"):
			validate_conversion_rate(args, meta)

		price_list_rate = get_price_list_rate_for(args, item_doc.name) or 0

		# variant
		if not price_list_rate and item_doc.variant_of:
			price_list_rate = get_price_list_rate_for(args, item_doc.variant_of)

		# insert in database
		if not price_list_rate:
			if args.price_list and args.rate:
				insert_item_price(args)
			return {}

		out.price_list_rate = flt(price_list_rate) * flt(args.plc_conversion_rate) \
			/ flt(args.conversion_rate)

		if not out.price_list_rate and args.transaction_type=="buying":
			from erpnext.stock.doctype.item.item import get_last_purchase_details
			out.update(get_last_purchase_details(item_doc.name,
				args.name, args.conversion_rate))


def get_bill_only_to_customer(item, args):
	bill_only_to_customer = None

	# from campaign
	if args.campaign:
		bill_only_to_customer = frappe.get_cached_value("Campaign", args.campaign, 'bill_only_to_customer')

	# from item defaults
	if not bill_only_to_customer:
		default_values = get_item_default_values(item, args)
		bill_only_to_customer = default_values.get('bill_only_to_customer')

	# from project warranty bill_to
	if not bill_only_to_customer:
		bill_only_to_customer = get_bill_only_to_customer_from_project(args.project)

	return bill_only_to_customer


def get_bill_only_to_customer_from_project(project):
	if not project:
		return None

	project_details = frappe.db.get_value("Project", project, ['customer', 'bill_to', 'is_warranty_claim'], as_dict=1)
	if not project_details:
		return None

	if project_details.is_warranty_claim and project_details.bill_to and project_details.bill_to != project_details.customer:
		return project_details.bill_to


def insert_item_price(args):
	"""Insert Item Price if Price List and Price List Rate are specified and currency is the same"""
	if frappe.db.get_value("Price List", args.price_list, "currency", cache=True) == args.currency \
		and cint(frappe.get_cached_value("Stock Settings", None, "auto_insert_price_list_rate_if_missing")):
		if frappe.has_permission("Item Price", "write"):
			price_list_rate = (args.rate / args.get('conversion_factor')
				if args.get("conversion_factor") else args.rate)

			item_price = frappe.db.get_value('Item Price',
				{'item_code': args.item_code, 'price_list': args.price_list, 'currency': args.currency},
				['name', 'price_list_rate'], as_dict=1)
			if item_price and item_price.name:
				if item_price.price_list_rate != price_list_rate:
					frappe.db.set_value('Item Price', item_price.name, "price_list_rate", price_list_rate)
					frappe.msgprint(_("Item Price updated for {0} in Price List {1}").format(args.item_code,
						args.price_list), alert=True)
			else:
				item_price = frappe.get_doc({
					"doctype": "Item Price",
					"price_list": args.price_list,
					"item_code": args.item_code,
					"currency": args.currency,
					"price_list_rate": price_list_rate
				})
				item_price.insert()
				frappe.msgprint(_("Item Price added for {0} in Price List {1}").format(args.item_code,
					args.price_list), alert=True)


def get_item_price(args, item_code, ignore_party=False):
	"""
		Get name, price_list_rate from Item Price based on conditions
			Check if the desired qty is within the increment of the packing list.
		:param args: dict (or frappe._dict) with mandatory fields price_list, uom
			optional fields transaction_date, customer, supplier
		:param item_code: str, Item Doctype field item_code
	"""

	args['item_code'] = item_code

	conditions = """where item_code=%(item_code)s
		and price_list=%(price_list)s"""
	order_by = "order by ifnull(valid_from, '2000-01-01') desc, uom desc"

	if not ignore_party:
		if args.get("customer"):
			conditions += " and customer=%(customer)s"
		elif args.get("supplier"):
			conditions += " and supplier=%(supplier)s"
		else:
			conditions += " and (customer is null or customer = '') and (supplier is null or supplier = '')"

	if args.get('transaction_date'):
		if args.get('period') == 'future':
			args['uom'] = args.get('uom', '')
			conditions += """ and ifnull(valid_from, '2000-01-01') > %(transaction_date)s and ifnull(uom, '') = %(uom)s"""
			order_by = "order by valid_from asc "
		else:
			conditions += """ and %(transaction_date)s between
				ifnull(valid_from, '2000-01-01') and ifnull(valid_upto, '2500-12-31')"""

	out = frappe.db.sql("""
		select name, price_list_rate, uom,
			ifnull(valid_from, '2000-01-01') as valid_from, ifnull(valid_upto, '2500-12-31') as valid_upto
		from `tabItem Price`
		{conditions} {order_by}
	""".format(conditions=conditions, order_by=order_by), args, as_list=1)

	matches_uom = list(filter(lambda d: cstr(d[2]) == cstr(args.get('uom')), out))
	if matches_uom:
		return matches_uom

	has_uom = list(filter(lambda d: d[2], out))
	if has_uom:
		# there are item prices with uom other than the current uom

		item = frappe.get_cached_doc("Item", item_code)
		item_uoms = [d.uom for d in item.uoms]

		convertible_prices = [d for d in has_uom if d[2] in item_uoms]
		if convertible_prices:
			has_uom_other_than_stock_uom = list(filter(lambda d: cstr(d[2]) != cstr(item.stock_uom), convertible_prices))
			if has_uom_other_than_stock_uom:
				return has_uom_other_than_stock_uom

		return convertible_prices

	return out


def get_price_list_rate_for(args, item_code):
	"""
		:param customer: link to Customer DocType
		:param supplier: link to Supplier DocType
		:param price_list: str (Standard Buying or Standard Selling)
		:param item_code: str, Item Doctype field item_code
		:param qty: Desired Qty
		:param transaction_date: Date of the price
	"""
	item_price_args = {
		"item_code": item_code,
		"price_list": args.get('price_list'),
		"customer": args.get('customer'),
		"supplier": args.get('supplier'),
		"uom": args.get('uom'),
		"transaction_date": args.get('transaction_date') or args.get('posting_date'),
	}

	item_price_data = 0
	price_list_rate = get_item_price(item_price_args, item_code)
	if price_list_rate:
		desired_qty = args.get("qty")
		if desired_qty is None:
			desired_qty = 1

		if desired_qty and check_packing_list(price_list_rate[0][0], desired_qty, item_code):
			item_price_data = price_list_rate
	else:
		for field in ["customer", "supplier"]:
			del item_price_args[field]

		general_price_list_rate = get_item_price(item_price_args, item_code,
			ignore_party=args.get("ignore_party"))

		if not general_price_list_rate and args.get("uom") != args.get("stock_uom"):
			item_price_args["uom"] = args.get("stock_uom")
			general_price_list_rate = get_item_price(item_price_args, item_code, ignore_party=args.get("ignore_party"))

		if general_price_list_rate:
			item_price_data = general_price_list_rate

	if item_price_data:
		if item_price_data[0][2] == args.get("uom"):
			return item_price_data[0][1]
		elif args.get('price_list_uom_dependant'):
			return convert_item_uom_for(value=item_price_data[0][1], item_code=item_code,
				from_uom=item_price_data[0][2], to_uom=args.get("uom"), conversion_factor=args.get("conversion_factor"))
		else:
			return item_price_data[0][1]


def check_packing_list(price_list_rate_name, desired_qty, item_code):
	"""
		Check if the desired qty is within the increment of the packing list.
		:param price_list_rate_name: Name of Item Price
		:param desired_qty: Desired Qt
		:param item_code: str, Item Doctype field item_code
		:param qty: Desired Qt
	"""

	flag = True
	item_price = frappe.get_doc("Item Price", price_list_rate_name)
	if item_price.packing_unit:
		packing_increment = desired_qty % item_price.packing_unit

		if packing_increment != 0:
			flag = False

	return flag


def validate_conversion_rate(args, meta):
	from erpnext.controllers.accounts_controller import validate_conversion_rate

	if (not args.conversion_rate
		and args.currency==frappe.get_cached_value('Company',  args.company,  "default_currency")):
		args.conversion_rate = 1.0

	# validate currency conversion rate
	validate_conversion_rate(args.currency, args.conversion_rate,
		meta.get_label("conversion_rate"), args.company)

	args.conversion_rate = flt(args.conversion_rate,
		get_field_precision(meta.get_field("conversion_rate"),
			frappe._dict({"fields": args})))

	if args.price_list:
		if (not args.plc_conversion_rate
			and args.price_list_currency==frappe.db.get_value("Price List", args.price_list, "currency", cache=True)):
			args.plc_conversion_rate = args.conversion_rate

		# validate price list currency conversion rate
		if not args.get("price_list_currency"):
			throw(_("Price List Currency not selected"))
		else:
			validate_conversion_rate(args.price_list_currency, args.plc_conversion_rate,
				meta.get_label("plc_conversion_rate"), args.company)

			if meta.get_field("plc_conversion_rate"):
				args.plc_conversion_rate = flt(args.plc_conversion_rate,
					get_field_precision(meta.get_field("plc_conversion_rate"),
					frappe._dict({"fields": args})))


def get_party_item_code(args, item_doc, out):
	if args.transaction_type=="selling" and args.customer:
		out.customer_item_code = None

		if args.quotation_to and args.quotation_to != 'Customer':
			return

		customer_item_code = item_doc.get("customer_items", {"customer_name": args.customer})

		if customer_item_code:
			out.customer_item_code = customer_item_code[0].ref_code
		else:
			customer_group = frappe.get_cached_value("Customer", args.customer, "customer_group")
			customer_group_item_code = item_doc.get("customer_items", {"customer_group": customer_group})
			if customer_group_item_code and not customer_group_item_code[0].customer_name:
				out.customer_item_code = customer_group_item_code[0].ref_code

	if args.transaction_type=="buying" and args.supplier:
		item_supplier = item_doc.get("supplier_items", {"supplier": args.supplier})
		out.supplier_part_no = item_supplier[0].supplier_part_no if item_supplier else None


def get_pos_profile_item_details(company, args, pos_profile=None, update_data=False):
	res = frappe._dict()

	if not frappe.flags.pos_profile and not pos_profile:
		pos_profile = frappe.flags.pos_profile = get_pos_profile(company, args.get('pos_profile'))

	if pos_profile:
		for fieldname in ("income_account", "cost_center", "warehouse", "expense_account"):
			if (not args.get(fieldname) or update_data) and pos_profile.get(fieldname):
				res[fieldname] = pos_profile.get(fieldname)

		if res.get("warehouse"):
			res.actual_qty = get_bin_details(args.item_code,
				res.warehouse).get("actual_qty")

	return res


@frappe.whitelist()
def get_pos_profile(company, pos_profile=None, user=None):
	if pos_profile: return frappe.get_cached_doc('POS Profile', pos_profile)

	if not user:
		user = frappe.session['user']

	condition = "pfu.user = %(user)s AND pfu.default=1"
	if user and company:
		condition = "pfu.user = %(user)s AND pf.company = %(company)s AND pfu.default=1"

	pos_profile = frappe.db.sql("""SELECT pf.*
		FROM
			`tabPOS Profile` pf LEFT JOIN `tabPOS Profile User` pfu
		ON
				pf.name = pfu.parent
		WHERE
			{cond} AND pf.disabled = 0
	""".format(cond = condition), {
		'user': user,
		'company': company
	}, as_dict=1)

	if not pos_profile and company:
		pos_profile = frappe.db.sql("""SELECT pf.*
			FROM
				`tabPOS Profile` pf LEFT JOIN `tabPOS Profile User` pfu
			ON
					pf.name = pfu.parent
			WHERE
				pf.company = %(company)s AND pf.disabled = 0
		""", {
			'company': company
		}, as_dict=1)

	return pos_profile and pos_profile[0] or None


def get_serial_nos_by_fifo(args, sales_order=None):
	if frappe.db.get_single_value("Stock Settings", "automatically_set_serial_nos_based_on_fifo"):
		return "\n".join(frappe.db.sql_list("""select name from `tabSerial No`
			where item_code=%(item_code)s and warehouse=%(warehouse)s and
			sales_order=IF(%(sales_order)s IS NULL, sales_order, %(sales_order)s)
			order by timestamp(purchase_date, purchase_time)
			asc limit %(qty)s""",
			{
				"item_code": args.item_code,
				"warehouse": args.warehouse,
				"qty": abs(cint(args.stock_qty)),
				"sales_order": sales_order
			}))


def get_serial_no_batchwise(args, sales_order=None):
	if frappe.db.get_single_value("Stock Settings", "automatically_set_serial_nos_based_on_fifo"):
		return "\n".join(frappe.db.sql_list("""select name from `tabSerial No`
			where item_code=%(item_code)s and warehouse=%(warehouse)s and
			sales_order=IF(%(sales_order)s IS NULL, sales_order, %(sales_order)s)
			and batch_no=IF(%(batch_no)s IS NULL, batch_no, %(batch_no)s) order
			by timestamp(purchase_date, purchase_time) asc limit %(qty)s""", {
				"item_code": args.item_code,
				"warehouse": args.warehouse,
				"batch_no": args.batch_no,
				"qty": abs(cint(args.stock_qty)),
				"sales_order": sales_order
			}))


@frappe.whitelist()
def get_conversion_factor(item_code, uom):
	# first look for direct conversion factor in item
	item = frappe.get_cached_doc("Item", item_code)
	item_conversion_factors = dict([(c.uom, c.conversion_factor) for c in item.uoms])
	conversion_factor = flt(item_conversion_factors.get(uom))

	# then look for conversion factor in template item if variant
	if not conversion_factor and item.variant_of:
		template_item = frappe.get_cached_doc("Item", item.variant_of)
		template_item_conversion_factors = dict([(c.uom, c.conversion_factor) for c in template_item.uoms])
		if uom in template_item_conversion_factors:
			conversion_factor = flt(item_conversion_factors.get(uom))

	# then look for global conversion factor for stock uom first then the rest of the item's convertible uoms
	if not conversion_factor:
		stock_uom = item.stock_uom
		item_uoms = [stock_uom] + [cuom for cuom, cf in item_conversion_factors.items() if cuom != stock_uom and flt(cf)]

		for item_uom in item_uoms:
			conversion_factor = flt(get_uom_conv_factor(uom, item_uom))
			if conversion_factor:
				if item_uom != stock_uom:
					# apply item_uom -> stock_uom conversion factor and then exit loop
					conversion_factor *= flt(item_conversion_factors.get(item_uom))
				break

	return frappe._dict({
		"conversion_factor": conversion_factor or 1.0,
		"not_convertible": 1 if not conversion_factor else 0
	})


@frappe.whitelist()
def get_projected_qty(item_code, warehouse):
	return {"projected_qty": frappe.db.get_value("Bin",
		{"item_code": item_code, "warehouse": warehouse}, "projected_qty")}


@frappe.whitelist()
def get_bin_details(item_code, warehouse):
	return frappe.db.get_value("Bin", {"item_code": item_code, "warehouse": warehouse},
		["projected_qty", "actual_qty", "reserved_qty"], as_dict=True, cache=True) \
			or {"projected_qty": 0, "actual_qty": 0, "reserved_qty": 0}


@frappe.whitelist()
def get_serial_no_details(item_code, warehouse, stock_qty, serial_no):
	args = frappe._dict({"item_code":item_code, "warehouse":warehouse, "stock_qty":stock_qty, "serial_no":serial_no})
	serial_no = get_serial_no(args)
	return {'serial_no': serial_no}


@frappe.whitelist()
def get_bin_details_and_serial_nos(item_code, warehouse, has_batch_no=None, stock_qty=None, serial_no=None):
	bin_details_and_serial_nos = {}
	bin_details_and_serial_nos.update(get_bin_details(item_code, warehouse))
	if flt(stock_qty) > 0:
		if has_batch_no:
			args = frappe._dict({"item_code":item_code, "warehouse":warehouse, "stock_qty":stock_qty})
			serial_no = get_serial_no(args)
			bin_details_and_serial_nos.update({'serial_no': serial_no})
			return bin_details_and_serial_nos

		bin_details_and_serial_nos.update(get_serial_no_details(item_code, warehouse, stock_qty, serial_no))
	return bin_details_and_serial_nos


@frappe.whitelist()
def get_batch_qty_and_serial_no(batch_no, stock_qty, warehouse, item_code, has_serial_no):
	batch_qty_and_serial_no = {}
	batch_qty_and_serial_no.update(get_batch_qty(batch_no, warehouse, item_code))

	if (flt(batch_qty_and_serial_no.get('actual_batch_qty')) >= flt(stock_qty)) and has_serial_no:
		args = frappe._dict({"item_code":item_code, "warehouse":warehouse, "stock_qty":stock_qty, "batch_no":batch_no})
		serial_no = get_serial_no(args)
		batch_qty_and_serial_no.update({'serial_no': serial_no})
	return batch_qty_and_serial_no


@frappe.whitelist()
def get_batch_qty(batch_no, warehouse, item_code):
	from erpnext.stock.doctype.batch import batch
	if batch_no:
		return {'actual_batch_qty': batch.get_batch_qty(batch_no, warehouse)}


@frappe.whitelist()
def apply_price_list(args, as_doc=False):
	"""Apply pricelist on a document-like dict object and return as
	{'parent': dict, 'children': list}

	:param args: See below
	:param as_doc: Updates value in the passed dict

		args = {
			"doctype": "",
			"name": "",
			"items": [{"doctype": "", "name": "", "item_code": "", "brand": "", "item_group": ""}, ...],
			"conversion_rate": 1.0,
			"selling_price_list": None,
			"price_list_currency": None,
			"price_list_uom_dependant": None,
			"plc_conversion_rate": 1.0,
			"doctype": "",
			"name": "",
			"supplier": None,
			"transaction_date": None,
			"conversion_rate": 1.0,
			"buying_price_list": None,
			"ignore_pricing_rule": 0/1
		}
	"""
	args = process_args(args)

	parent = get_price_list_currency_and_exchange_rate(args)
	children = []

	if "items" in args:
		item_list = args.get("items")
		args.update(parent)

		for item in item_list:
			args_copy = frappe._dict(args.copy())
			args_copy.update(item)
			item_details = apply_price_list_on_item(args_copy)
			children.append(item_details)

	if as_doc:
		args.price_list_currency = parent.price_list_currency,
		args.plc_conversion_rate = parent.plc_conversion_rate
		if args.get('items'):
			for i, item in enumerate(args.get('items')):
				for fieldname in children[i]:
					# if the field exists in the original doc
					# update the value
					if fieldname in item and fieldname not in ("name", "doctype"):
						item[fieldname] = children[i][fieldname]
		return args
	else:
		return {
			"parent": parent,
			"children": children
		}


def apply_price_list_on_item(args):
	item_details = frappe._dict()
	item_doc = frappe.get_cached_doc("Item", args.item_code)
	get_price_list_rate(args, item_doc, item_details)

	item_details.update(get_pricing_rule_for_item(args, item_details.price_list_rate))

	return item_details


def get_price_list_currency_and_exchange_rate(args):
	if not args.price_list:
		return {}

	if args.doctype in ['Quotation', 'Sales Order', 'Delivery Note', 'Sales Invoice']:
		args.update({"exchange_rate": "for_selling"})
	elif args.doctype in ['Purchase Order', 'Purchase Receipt', 'Purchase Invoice']:
		args.update({"exchange_rate": "for_buying"})

	price_list_details = get_price_list_details(args.price_list)

	price_list_currency = price_list_details.get("currency")
	price_list_uom_dependant = not price_list_details.get("price_not_uom_dependent")

	plc_conversion_rate = args.plc_conversion_rate
	company_currency = get_company_currency(args.company)

	if (not plc_conversion_rate) or (price_list_currency and args.price_list_currency \
		and price_list_currency != args.price_list_currency):
			# cksgb 19/09/2016: added args.transaction_date as posting_date argument for get_exchange_rate
			plc_conversion_rate = get_exchange_rate(price_list_currency, company_currency,
				args.transaction_date, args.exchange_rate) or plc_conversion_rate

	return frappe._dict({
		"price_list_currency": price_list_currency,
		"price_list_uom_dependant": price_list_uom_dependant,
		"plc_conversion_rate": plc_conversion_rate
	})


@frappe.whitelist()
def get_default_bom(item_code=None):
	if item_code:
		bom = frappe.db.get_value("BOM", {"docstatus": 1, "is_default": 1, "is_active": 1, "item": item_code})
		if bom:
			return bom


def get_valuation_rate(item_code, company, warehouse=None, transaction_type_name=None):
	item = frappe.get_cached_doc("Item", item_code)
	default_values = get_item_default_values(item, {"company": company, "transaction_type": transaction_type_name})

	if item.get("is_stock_item"):
		if not warehouse:
			warehouse = default_values.get("default_warehouse")

		return frappe.db.get_value("Bin", {"item_code": item_code, "warehouse": warehouse},
			["valuation_rate"], as_dict=True) or {"valuation_rate": 0}

	elif not item.get("is_stock_item"):
		valuation_rate = frappe.db.sql("""select sum(base_net_amount) / sum(qty*conversion_factor)
			from `tabPurchase Invoice Item`
			where item_code = %s and docstatus=1""", item_code)

		if valuation_rate:
			return {"valuation_rate": valuation_rate[0][0] or 0.0}
	else:
		return {"valuation_rate": 0.0}


def get_gross_profit(out):
	if out.valuation_rate:
		out.update({
			"gross_profit": ((out.base_rate - out.valuation_rate) * out.stock_qty)
		})

	return out


@frappe.whitelist()
def get_serial_no(args, serial_nos=None, sales_order=None):
	serial_no = None
	if isinstance(args, string_types):
		args = json.loads(args)
		args = frappe._dict(args)
	if args.get('doctype') == 'Sales Invoice' and not args.get('update_stock'):
		return ""
	if args.get('warehouse') and args.get('stock_qty') and args.get('item_code'):
		has_serial_no = frappe.get_value('Item', {'item_code': args.item_code}, "has_serial_no")
		if args.get('batch_no') and has_serial_no == 1:
			return get_serial_no_batchwise(args, sales_order)
		elif has_serial_no == 1:
			args = json.dumps({"item_code": args.get('item_code'),"warehouse": args.get('warehouse'),"stock_qty": args.get('stock_qty')})
			args = process_args(args)
			serial_no = get_serial_nos_by_fifo(args, sales_order)

	if not serial_no and serial_nos:
		# For POS
		serial_no = serial_nos

	return serial_no


def update_party_blanket_order(args, out):
	blanket_order_details = get_blanket_order_details(args)
	if blanket_order_details:
		out.update(blanket_order_details)


@frappe.whitelist()
def get_blanket_order_details(args):
	if isinstance(args, string_types):
		args = frappe._dict(json.loads(args))

	blanket_order_details = None
	condition = ''
	if args.item_code:
		if args.customer and args.doctype == "Sales Order":
			condition = ' and bo.customer=%(customer)s'
		elif args.supplier and args.doctype == "Purchase Order":
			condition = ' and bo.supplier=%(supplier)s'
		if args.blanket_order:
			condition += ' and bo.name =%(blanket_order)s'
		if args.transaction_date:
			condition += ' and bo.to_date>=%(transaction_date)s'

		blanket_order_details = frappe.db.sql('''
				select boi.rate as blanket_order_rate, bo.name as blanket_order
				from `tabBlanket Order` bo, `tabBlanket Order Item` boi
				where bo.company=%(company)s and boi.item_code=%(item_code)s
					and bo.docstatus=1 and bo.name = boi.parent {0}
			'''.format(condition), args, as_dict=True)

		blanket_order_details = blanket_order_details[0] if blanket_order_details else ''
	return blanket_order_details


def get_so_reservation_for_item(args):
	reserved_so = None
	if args.get('sales_order'):
		if get_reserved_qty_for_so(args.get('sales_order'), args.get('item_code')):
			reserved_so = args.get('sales_order')
	elif args.get('sales_invoice'):
		sales_order = frappe.db.sql("""select sales_order from `tabSales Invoice Item` where
		parent=%s and item_code=%s""", (args.get('sales_invoice'), args.get('item_code')))
		if sales_order and sales_order[0]:
			if get_reserved_qty_for_so(sales_order[0][0], args.get('item_code')):
				reserved_so = sales_order[0]
	elif args.get("sales_order"):
		if get_reserved_qty_for_so(args.get('sales_order'), args.get('item_code')):
			reserved_so = args.get('sales_order')
	return reserved_so


def get_reserved_qty_for_so(sales_order, item_code):
	reserved_qty = frappe.db.sql("""select sum(qty) from `tabSales Order Item`
	where parent=%s and item_code=%s and ensure_delivery_based_on_produced_serial_no=1
	""", (sales_order, item_code))
	if reserved_qty and reserved_qty[0][0]:
		return reserved_qty[0][0]
	else:
		return 0


@frappe.whitelist()
def get_applies_to_details(args, for_validate=False):
	if isinstance(args, string_types):
		args = json.loads(args)

	args = frappe._dict(args)
	out = frappe._dict()

	# Get Vehicle and Vehicle's Item Code
	vehicle = frappe._dict()
	if args.applies_to_vehicle:
		vehicle = frappe.get_doc("Vehicle", args.applies_to_vehicle)
		out.applies_to_item = vehicle.item_code

	# Get Project
	project = None
	if args.project and args.doctype != 'Project':
		if frappe.get_meta("Project").has_field('applies_to_vehicle'):
			project = frappe.db.get_value("Project", args.project, [
				'name', 'applies_to_vehicle',
				'vehicle_chassis_no', 'vehicle_engine_no',
				'vehicle_license_plate', 'vehicle_unregistered',
				'vehicle_color', 'vehicle_last_odometer',
			], as_dict=1)

	# Vehicle Details
	# Get Vehicle Details from Project if Vehicle is the same in Transaction and Project
	if project and project.applies_to_vehicle and project.applies_to_vehicle == args.applies_to_vehicle:
		out.vehicle_chassis_no = project.vehicle_chassis_no
		out.vehicle_engine_no = project.vehicle_engine_no
		out.vehicle_license_plate = project.vehicle_license_plate
		out.vehicle_unregistered = project.vehicle_unregistered
		out.vehicle_color = project.vehicle_color
		out.vehicle_last_odometer = project.vehicle_last_odometer
		out.vehicle_warranty_no = project.vehicle_warranty_no
		out.vehicle_delivery_date = project.vehicle_delivery_date

	# Otherwise get it from the Vehicle
	elif vehicle:
		out.vehicle_chassis_no = vehicle.chassis_no
		out.vehicle_engine_no = vehicle.engine_no
		out.vehicle_license_plate = vehicle.license_plate
		out.vehicle_unregistered = vehicle.unregistered
		out.vehicle_color = vehicle.color
		out.vehicle_warranty_no = vehicle.warranty_no
		out.vehicle_delivery_date = vehicle.delivery_date

		if args.doctype != "Project":
			out.vehicle_last_odometer = get_applies_to_vehicle_odometer(args.applies_to_vehicle)

	# If called by Project, get first and last project's odometer readings
	if vehicle and args.doctype == "Project" and not for_validate:
		from erpnext.vehicles.doctype.vehicle_log.vehicle_log import get_project_odometer
		out.update(get_project_odometer(args.name, vehicle.name))

	# Item Details
	item = frappe._dict()
	item_code = out.applies_to_item or args.applies_to_item
	if item_code:
		item = frappe.get_cached_doc("Item", item_code)

	if item:
		out.applies_to_item_name = item.item_name
	out.applies_to_variant_of = item.variant_of
	out.applies_to_variant_of_name = frappe.get_cached_value("Item", item.variant_of, 'item_name') if item.variant_of else None

	# Vehicle Owner
	vehicle_owner = args.vehicle_owner
	out.vehicle_owner_name = frappe.get_cached_value("Customer", vehicle_owner, 'customer_name') if vehicle_owner\
		else None

	# Image
	if args.doctype == "Project":
		out.image = vehicle.image or item.image

	return out


@frappe.whitelist()
def get_applies_to_vehicle_odometer(vehicle, project=None):
	from erpnext.vehicles.doctype.vehicle_log.vehicle_log import get_vehicle_odometer

	if vehicle:
		return get_vehicle_odometer(vehicle, project=project)
	else:
		return 0
