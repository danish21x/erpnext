// Copyright (c) 2015, Frappe Technologies Pvt. Ltd. and Contributors
// License: GNU General Public License v3. See license.txt

erpnext.TransactionController = erpnext.taxes_and_totals.extend({
	setup: function() {
		frappe.flags.hide_serial_batch_dialog = true
		this._super();
		frappe.ui.form.on(this.frm.doctype + " Item", "rate", function(frm, cdt, cdn) {
			var item = frappe.get_doc(cdt, cdn);
			var margin_df = frappe.meta.get_docfield(cdt, 'margin_type');

			if(item.price_list_rate) {
				if(item.rate > item.price_list_rate && margin_df) {
					// if rate is greater than price_list_rate, set margin
					// or set discount
					item.discount_amount = 0;
					item.discount_percentage = 0;

					if (!['Amount', 'Percentage'].includes(item.margin_type)) {
						item.margin_type = margin_df['default'] || 'Amount';
					}
					if (item.margin_type === 'Amount') {
						item.margin_rate_or_amount = flt(item.rate - item.price_list_rate,
							precision("margin_rate_or_amount", item));
					} else {
						item.margin_rate_or_amount = (item.rate / item.price_list_rate - 1) * 100;
					}
					item.rate_with_margin = item.rate;
				} else {
					item.discount_amount = flt(item.price_list_rate - item.rate);
					item.discount_percentage = flt((1 - item.rate / item.price_list_rate) * 100.0);
					item.discount_amount = flt(item.price_list_rate) - flt(item.rate);
					item.margin_type = '';
					item.margin_rate_or_amount = 0;
					item.rate_with_margin = 0;
				}
			} else {
				item.discount_amount = 0;
				item.discount_percentage = 0.0;
				item.margin_type = '';
				item.margin_rate_or_amount = 0;
				item.rate_with_margin = 0;
			}
			item.base_rate_with_margin = item.rate_with_margin * flt(frm.doc.conversion_rate);

			cur_frm.cscript.set_gross_profit(item);
			cur_frm.cscript.calculate_taxes_and_totals();

		});

		frappe.ui.form.on(this.frm.doctype + " Item", "amount", function(frm, cdt, cdn) {
			var item = frappe.get_doc(cdt, cdn);

			item.amount = flt(item.amount, precision('amount', item));
			if (flt(item.qty)) {
				frappe.model.set_value(cdt, cdn, 'rate', item.amount / flt(item.qty));
			} else {
				frappe.model.set_value(cdt, cdn, 'rate', item.amount);
			}
		});

		frappe.ui.form.on(this.frm.doctype + " Item", "amount_before_discount", function(frm, cdt, cdn) {
			var item = frappe.get_doc(cdt, cdn);
			var margin_df = frappe.meta.get_docfield(cdt, 'margin_type');

			if (margin_df) {
				item.margin_rate_or_amount = 0;
			}

			item.amount_before_discount = flt(item.amount_before_discount, precision('amount_before_discount', item));
			if (flt(item.qty)) {
				item.price_list_rate = item.amount_before_discount / flt(item.qty);
			} else {
				item.price_list_rate = item.amount_before_discount;
			}

			frappe.model.trigger('price_list_rate', item.price_list_rate, item);
		});

		frappe.ui.form.on(this.frm.doctype + " Item", "total_discount", function(frm, cdt, cdn) {
			var item = frappe.get_doc(cdt, cdn);

			item.total_discount = flt(item.total_discount, precision('total_discount', item));
			if (flt(item.qty)) {
				frappe.model.set_value(cdt, cdn, 'discount_amount', item.total_discount / flt(item.qty));
			} else {
				frappe.model.set_value(cdt, cdn, 'discount_amount', item.total_discount);
			}
		});

		frappe.ui.form.on(this.frm.doctype + " Item", "tax_inclusive_amount", function(frm, cdt, cdn) {
			var item = frappe.get_doc(cdt, cdn);

			item.tax_inclusive_amount = flt(item.tax_inclusive_amount);
			if (flt(item.qty)) {
				frappe.model.set_value(cdt, cdn, 'tax_inclusive_rate', item.tax_inclusive_amount / flt(item.qty));
			} else {
				frappe.model.set_value(cdt, cdn, 'tax_inclusive_rate', item.tax_inclusive_amount);
			}
		});

		frappe.ui.form.on(this.frm.doctype + " Item", "tax_inclusive_rate", function(frm, cdt, cdn) {
			var tax_rows = (frm.doc.taxes || []).filter(tax => !tax.exclude_from_item_tax_amount);

			var invalid_charge_types = tax_rows.filter(tax => tax.charge_type != 'On Net Total');
			if (invalid_charge_types.length) {
				frappe.msgprint(__('Cannot calculate Rate from Tax Inclusive Rate'));
				frm.cscript.calculate_taxes_and_totals();
				return
			}

			var item = frappe.get_doc(cdt, cdn);
			var item_tax_map = frm.cscript._load_item_tax_rate(item.item_tax_rate);

			var tax_fraction = 0;
			$.each(tax_rows, function (i, tax) {
				var tax_rate = frm.cscript._get_tax_rate(tax, item_tax_map);
				tax_fraction += tax_rate / 100;
			});

			item.tax_inclusive_rate = flt(item.tax_inclusive_rate);

			var rate;
			if (cint(item.apply_discount_after_taxes)) {
				rate = item.tax_inclusive_rate - flt(item.taxable_rate) * tax_fraction;
			} else {
				rate = item.tax_inclusive_rate / (1 + tax_fraction);
			}

			frappe.model.set_value(cdt, cdn, 'rate', rate);
		});

		frappe.ui.form.on(this.frm.cscript.tax_table, "rate", function(frm, cdt, cdn) {
			cur_frm.cscript.calculate_taxes_and_totals();
		});

		frappe.ui.form.on(this.frm.cscript.tax_table, "tax_amount", function(frm, cdt, cdn) {
			cur_frm.cscript.calculate_taxes_and_totals();
		});

		frappe.ui.form.on(this.frm.cscript.tax_table, "base_tax_amount", function(frm, cdt, cdn) {
			if (flt(frm.doc.conversion_rate)>0.0) {
				var tax = locals[cdt][cdn];
				tax.tax_amount = flt(tax.base_tax_amount) / flt(frm.doc.conversion_rate);
				cur_frm.cscript.calculate_taxes_and_totals();
			}
		});

		frappe.ui.form.on(this.frm.cscript.tax_table, "row_id", function(frm, cdt, cdn) {
			cur_frm.cscript.calculate_taxes_and_totals();
		});

		frappe.ui.form.on(this.frm.cscript.tax_table, "included_in_print_rate", function(frm, cdt, cdn) {
			cur_frm.cscript.set_dynamic_labels();
			cur_frm.cscript.calculate_taxes_and_totals();
		});

		frappe.ui.form.on(this.frm.cscript.tax_table, "apply_on_net_amount", function(frm, cdt, cdn) {
			cur_frm.cscript.calculate_taxes_and_totals();
		});

		frappe.ui.form.on(this.frm.cscript.tax_table, {
			taxes_remove: function(frm, cdt, cdn) {
				cur_frm.cscript.set_dynamic_labels();
				cur_frm.cscript.calculate_taxes_and_totals();
			}
		});

		frappe.ui.form.on(this.frm.doctype, "calculate_tax_on_company_currency", function(frm, cdt, cdn) {
			cur_frm.cscript.calculate_taxes_and_totals();
		});

		frappe.ui.form.on(this.frm.doctype, "apply_discount_on", function(frm) {
			if(frm.doc.additional_discount_percentage) {
				frm.trigger("additional_discount_percentage");
			} else {
				cur_frm.cscript.calculate_taxes_and_totals();
			}
		});

		frappe.ui.form.on(this.frm.doctype, "additional_discount_percentage", function(frm) {
			if(!frm.doc.apply_discount_on) {
				frappe.msgprint(__("Please set 'Apply Additional Discount On'"));
				return;
			}

			frm.via_discount_percentage = true;

			if(frm.doc.additional_discount_percentage && frm.doc.discount_amount) {
				// Reset discount amount and net / grand total
				frm.doc.discount_amount = 0;
				frm.cscript.calculate_taxes_and_totals();
			}

			var total = flt(frm.doc[frappe.model.scrub(frm.doc.apply_discount_on)]);
			var discount_amount = flt(total*flt(frm.doc.additional_discount_percentage) / 100,
				precision("discount_amount"));

			frm.set_value("discount_amount", discount_amount)
				.then(() => delete frm.via_discount_percentage);
		});

		frappe.ui.form.on(this.frm.doctype, "discount_amount", function(frm) {
			frm.cscript.set_dynamic_labels();

			if (!frm.via_discount_percentage) {
				frm.doc.additional_discount_percentage = 0;
			}

			frm.cscript.calculate_taxes_and_totals();
		});

		frappe.ui.form.on(this.frm.doctype + " Item", {
			items_add: function(frm, cdt, cdn) {
				var item = frappe.get_doc(cdt, cdn);
				if(!item.warehouse && frm.doc.set_warehouse) {
					item.warehouse = frm.doc.set_warehouse;
				}
			}
		});

		frappe.ui.form.on(this.frm.doctype,"project", function(frm) {
			if (frm.doc.bill_multiple_projects && frm.doc.project) {
				frm.doc.project = null;
				frm.refresh_field('project');
			}
			if (frm.doc.project) {
				return frappe.call({
					method: 'erpnext.projects.doctype.project.project.get_project_details',
					args: {
						project: frm.doc.project,
						doctype: frm.doc.doctype
					},
					callback: function (r) {
						if (!r.exc) {
							var customer = null;
							var bill_to = null;
							var applies_to_vehicle = null;

							// Set Customer and Bill To first
							if (r.message.customer) {
								customer = r.message.customer;
								delete r.message['customer'];
							}
							if (r.message.bill_to) {
								bill_to = r.message.bill_to;
								delete r.message['bill_to'];
							}

							// Set Applies to Vehicle Later
							if (r.message.applies_to_vehicle) {
								applies_to_vehicle = r.message['applies_to_vehicle'];
								delete r.message['applies_to_vehicle'];
								delete r.message['applies_to_item'];
							// Remove Applies to Vehicle if Applies to Item is given
							} else if (r.message.applies_to_item && frm.fields_dict.applies_to_vehicle) {
								frm.doc.applies_to_vehicle = null;
								frm.refresh_field('applies_to_vehicle');
							}

							return frappe.run_serially([
								() => {
									if (bill_to && frm.fields_dict.bill_to) {
										frm.doc.customer = customer;
										return frm.set_value('bill_to', bill_to);
									} else if (customer && frm.fields_dict.customer) {
										return frm.set_value('customer', customer);
									}
								},
								() => frm.set_value(r.message),
								() => {
									if (applies_to_vehicle && frm.fields_dict.applies_to_vehicle) {
										return frm.set_value("applies_to_vehicle", applies_to_vehicle);
									}
								},
							]);
						}
					}
				});
			} else {
				if (frm.fields_dict.project_reference_no) {
					frm.set_value("project_reference_no", null);
				}
				return frm.cscript.get_applies_to_details();
			}
		});


		var me = this;
		if(this.frm.fields_dict["items"].grid.get_field('batch_no')) {
			this.frm.set_query("batch_no", "items", function(doc, cdt, cdn) {
				return me.set_query_for_batch(doc, cdt, cdn);
			});
		}

		if(
			this.frm.docstatus < 2
			&& this.frm.fields_dict["payment_terms_template"]
			&& this.frm.fields_dict["payment_schedule"]
			&& this.frm.doc.payment_terms_template
			&& !this.frm.doc.payment_schedule.length
		){
			this.frm.trigger("payment_terms_template");
		}

		if(this.frm.fields_dict["items"]) {
			this["items_remove"] = this.calculate_net_weight;
		}

		if(this.frm.fields_dict["recurring_print_format"]) {
			this.frm.set_query("recurring_print_format", function(doc) {
				return{
					filters: [
						['Print Format', 'doc_type', '=', cur_frm.doctype],
					]
				};
			});
		}

		this.frm.set_query("uom", "items", function(doc, cdt, cdn) {
			var d = locals[cdt][cdn];
			return {
				query : "erpnext.controllers.queries.item_uom_query",
				filters: {
					item_code: d.item_code
				}
			}
		});

		if(this.frm.fields_dict["return_against"]) {
			this.frm.set_query("return_against", function(doc) {
				var filters = {
					"docstatus": 1,
					"is_return": 0,
					"company": doc.company
				};
				if (me.frm.fields_dict["customer"] && doc.customer) filters["customer"] = doc.customer;
				if (me.frm.fields_dict["supplier"] && doc.supplier) filters["supplier"] = doc.supplier;

				return {
					filters: filters
				};
			});
		}
		if (this.frm.fields_dict["items"].grid.get_field("cost_center")) {
			this.frm.set_query("cost_center", "items", function(doc) {
				return {
					filters: {
						"company": doc.company,
						"is_group": 0
					}
				};
			});
		}

		if (this.frm.fields_dict["cost_center"]) {
			this.frm.set_query("cost_center", function(doc) {
				return {
					filters: {
						"company": doc.company,
						"is_group": 0
					}
				};
			});
		}

		if (this.frm.fields_dict["items"].grid.get_field("expense_account")) {
			this.frm.set_query("expense_account", "items", function(doc) {
				return {
					filters: {
						"company": doc.company,
						"is_group": 0
					}
				};
			});
		}

		if(frappe.meta.get_docfield(this.frm.doc.doctype, "pricing_rules")) {
			this.frm.set_indicator_formatter('pricing_rule', function(doc) {
				return (doc.rule_applied) ? "green" : "red";
			});
		}

		let batch_no_field = this.frm.get_docfield("items", "batch_no");
		if (batch_no_field) {
			batch_no_field.get_route_options_for_new_doc = function(row) {
				return {
					"item": row.doc.item_code
				}
			};
		}

		if (this.frm.fields_dict["items"].grid.get_field('blanket_order')) {
			this.frm.set_query("blanket_order", "items", function(doc, cdt, cdn) {
				var item = locals[cdt][cdn];
				return {
					query: "erpnext.controllers.queries.get_blanket_orders",
					filters: {
						"company": doc.company,
						"blanket_order_type": doc.doctype === "Sales Order" ? "Selling" : "Purchasing",
						"item": item.item_code
					}
				}
			});
		}

		var vehicle_field = me.frm.get_docfield("applies_to_vehicle");
		if (vehicle_field) {
			vehicle_field.get_route_options_for_new_doc = function () {
				return {
					"item_code": me.frm.doc.applies_to_item,
					"item_name": me.frm.doc.applies_to_item_name,
					"unregistered": me.frm.doc.vehicle_unregistered,
					"license_plate": me.frm.doc.vehicle_license_plate,
					"chassis_no": me.frm.doc.vehicle_chassis_no,
					"engine_no": me.frm.doc.vehicle_engine_no,
					"color": me.frm.doc.vehicle_color,
				}
			}
		}

		if (this.frm.doc.__onload && this.frm.doc.__onload.enable_dynamic_bundling) {
			erpnext.bundling.setup_bundling(this.frm.doc.doctype);
		}
	},
	onload: function() {
		var me = this;

		if(this.frm.doc.__islocal) {
			var currency = frappe.defaults.get_user_default("currency");

			let set_value = (fieldname, value) => {
				if(me.frm.fields_dict[fieldname] && !me.frm.doc[fieldname]) {
					return me.frm.set_value(fieldname, value);
				}
			};

			return frappe.run_serially([
				() => set_value('currency', currency),
				() => set_value('price_list_currency', currency),
				() => set_value('status', 'Draft'),
				() => set_value('is_subcontracted', 'No'),
				() => {
					if(this.frm.doc.company && !this.frm.doc.amended_from) {
						this.set_company_defaults();
					}
				}
			]);
		}
	},

	is_return: function() {
		if(!this.frm.doc.is_return && this.frm.doc.return_against) {
			this.frm.set_value('return_against', '');
		}
	},

	setup_quality_inspection: function() {
		if(!in_list(["Delivery Note", "Sales Invoice", "Purchase Receipt", "Purchase Invoice"], this.frm.doc.doctype)) {
			return;
		}
		var me = this;
		var inspection_type = in_list(["Purchase Receipt", "Purchase Invoice"], this.frm.doc.doctype)
			? "Incoming" : "Outgoing";

		var quality_inspection_field = this.frm.get_docfield("items", "quality_inspection");
		quality_inspection_field.get_route_options_for_new_doc = function(row) {
			if(me.frm.is_new()) return;
			return {
				"inspection_type": inspection_type,
				"reference_type": me.frm.doc.doctype,
				"reference_name": me.frm.doc.name,
				"item_code": row.doc.item_code,
				"description": row.doc.description,
				"item_serial_no": row.doc.serial_no ? row.doc.serial_no.split("\n")[0] : null,
				"batch_no": row.doc.batch_no,
				"project": inspection_type == "Incoming" ? row.doc.project : me.frm.doc.project
			}
		}

		this.frm.set_query("quality_inspection", "items", function(doc, cdt, cdn) {
			var d = locals[cdt][cdn];
			return {
				filters: {
					docstatus: 1,
					inspection_type: inspection_type,
					reference_name: doc.name,
					item_code: d.item_code
				}
			}
		});
	},

	make_payment_request: function() {
		var me = this;
		const payment_request_type = (in_list(['Sales Order', 'Sales Invoice'], this.frm.doc.doctype))
			? "Inward" : "Outward";

		frappe.call({
			method:"erpnext.accounts.doctype.payment_request.payment_request.make_payment_request",
			args: {
				dt: me.frm.doc.doctype,
				dn: me.frm.doc.name,
				recipient_id: me.frm.doc.contact_email,
				payment_request_type: payment_request_type,
				party_type: payment_request_type == 'Outward' ? "Supplier" : "Customer",
				party: payment_request_type == 'Outward' ? me.frm.doc.supplier : me.frm.doc.customer
			},
			callback: function(r) {
				if(!r.exc){
					var doc = frappe.model.sync(r.message);
					frappe.set_route("Form", r.message.doctype, r.message.name);
				}
			}
		})
	},

	onload_post_render: function() {
		if(this.frm.doc.__islocal && !(this.frm.doc.taxes || []).length
			&& !(this.frm.doc.__onload ? this.frm.doc.__onload.load_after_mapping : false)) {
			frappe.after_ajax(() => this.apply_default_taxes());
		} else if(this.frm.doc.__islocal && this.frm.doc.company && this.frm.doc["items"]
			&& !this.frm.doc.is_pos) {
			frappe.after_ajax(() => this.calculate_taxes_and_totals());
		}
		if(frappe.meta.get_docfield(this.frm.doc.doctype + " Item", "item_code")) {
			this.setup_item_selector();
			this.frm.get_field("items").grid.set_multiple_add("item_code", "qty");
		}
	},

	refresh: function() {
		erpnext.toggle_naming_series();
		erpnext.hide_company();
		this.set_dynamic_labels();
		this.setup_sms();
		this.setup_quality_inspection();
		this.set_applies_to_read_only();

		let scan_barcode_field = this.frm.get_field('scan_barcode');
		if (scan_barcode_field) {
			scan_barcode_field.set_value("");
			scan_barcode_field.set_new_description("");

			if (frappe.is_mobile()) {
				if (scan_barcode_field.$input_wrapper.find('.input-group').length) return;

				let $input_group = $('<div class="input-group">');
				scan_barcode_field.$input_wrapper.find('.control-input').append($input_group);
				$input_group.append(scan_barcode_field.$input);
				$(`<span class="input-group-btn" style="vertical-align: top">
						<button class="btn btn-default border" type="button">
							<i class="fa fa-camera text-muted"></i>
						</button>
					</span>`)
					.on('click', '.btn', () => {
						frappe.barcode.scan_barcode().then(barcode => {
							scan_barcode_field.set_value(barcode);
						});
					})
					.appendTo($input_group);
			}
		}
	},

	update_item_prices: function() {
		var me = this;
		var frm = this.frm;

		var rows;
		var checked_rows = frm.fields_dict.items.grid.grid_rows.filter(row => row.doc.__checked);
		if (checked_rows.length) {
			rows = checked_rows;
		} else {
			rows = frm.fields_dict.items.grid.grid_rows;
		}

		rows = rows
			.filter(row => row.doc.item_code && (row.doc.price_list_rate || row.doc.rate))
			.map(function(row) { return {
				item_code: row.doc.item_code,
				item_name: row.doc.item_name,
				price_list_rate: row.doc.price_list_rate || row.doc.rate,
				uom: row.doc.uom,
				conversion_factor: row.doc.conversion_factor
			}});

		var price_list = frm.doc.selling_price_list || frm.doc.buying_price_list;
		var date = frm.doc.transaction_date || frm.doc.posting_date;
		this.data = [];

		if (price_list && rows.length) {
			var dialog = new frappe.ui.Dialog({
				title: __("Update Price List {0}", [price_list]), fields: [
					{label: __("Effective Date"), fieldname: "effective_date", fieldtype: "Date", default: date, reqd: 1},
					{label: __("Item Prices"), fieldname: "items", fieldtype: "Table", data: this.data,
						get_data: () => this.data,
						cannot_add_rows: true, in_place_edit: true,
						fields: [
							{
								label: __('Item Code'),
								fieldname:"item_code",
								fieldtype:'Link',
								options: 'Item',
								read_only: 1,
								in_list_view: 1,
								columns: 6,
							},
							{
								label: __('Item Name'),
								fieldname:"item_name",
								fieldtype:'Data',
								read_only: 1,
								in_list_view: 0,
								columns: 4,
							},
							{
								label: __('UOM'),
								fieldtype:'Link',
								fieldname:"uom",
								read_only: 1,
								in_list_view: 1,
								columns: 2,
							},
							{
								label: __('New Rate'),
								fieldtype:'Currency',
								fieldname:"price_list_rate",
								default: 0,
								read_only: 1,
								in_list_view: 1,
								columns: 2,
							},
							{
								label: __('Conversion Factor'),
								fieldtype:'Float',
								precision: 9,
								fieldname:"conversion_factor",
								read_only: 1
							}
						]
					}
				]
			});

			dialog.fields_dict.items.df.data = rows;
			this.data = dialog.fields_dict.items.df.data;
			dialog.fields_dict.items.grid.refresh();

			dialog.show();
			dialog.set_primary_action(__('Update Price List'), function() {
				var updated_items = this.get_values()["items"];
				return frappe.call({
					method: "erpnext.stock.report.item_prices.item_prices.set_multiple_item_pl_rate",
					args: {
						effective_date: dialog.get_value('effective_date'),
						items: updated_items,
						price_list: price_list
					},
					callback: function() {
						dialog.hide();
					}
				});
			});
		}
	},

	scan_barcode: function() {
		let scan_barcode_field = this.frm.fields_dict["scan_barcode"];

		let show_description = function(idx, exist = null) {
			if (exist) {
				scan_barcode_field.set_new_description(__('Row #{0}: Qty increased by 1', [idx]));
			} else {
				scan_barcode_field.set_new_description(__('Row #{0}: Item added', [idx]));
			}
		}

		if(this.frm.doc.scan_barcode) {
			frappe.call({
				method: "erpnext.selling.page.point_of_sale.point_of_sale.search_serial_or_batch_or_barcode_number",
				args: { search_value: this.frm.doc.scan_barcode }
			}).then(r => {
				const data = r && r.message;
				if (!data || Object.keys(data).length === 0) {
					scan_barcode_field.set_new_description(__('Cannot find Item with this barcode'));
					return;
				}

				let cur_grid = this.frm.fields_dict.items.grid;

				let row_to_modify = null;
				const existing_item_row = this.frm.doc.items.find(d => d.item_code === data.item_code);
				const blank_item_row = this.frm.doc.items.find(d => !d.item_code);

				if (existing_item_row) {
					row_to_modify = existing_item_row;
				} else if (blank_item_row) {
					row_to_modify = blank_item_row;
				}

				if (!row_to_modify) {
					// add new row
					row_to_modify = frappe.model.add_child(this.frm.doc, cur_grid.doctype, 'items');
				}

				show_description(row_to_modify.idx, row_to_modify.item_code);

				this.frm.from_barcode = true;
				frappe.model.set_value(row_to_modify.doctype, row_to_modify.name, {
					item_code: data.item_code,
					qty: (row_to_modify.qty || 0) + 1
				});

				['serial_no', 'batch_no', 'barcode'].forEach(field => {
					if (data[field] && frappe.meta.has_field(row_to_modify.doctype, field)) {

						let value = (row_to_modify[field] && field === "serial_no")
							? row_to_modify[field] + '\n' + data[field] : data[field];

						frappe.model.set_value(row_to_modify.doctype,
							row_to_modify.name, field, value);
					}
				});

				scan_barcode_field.set_value('');
				refresh_field("items");
			});
		}
		return false;
	},

	apply_default_taxes: function() {
		var me = this;
		var taxes_and_charges_field = frappe.meta.get_docfield(me.frm.doc.doctype, "taxes_and_charges",
			me.frm.doc.name);

		if (!this.frm.doc.taxes_and_charges && this.frm.doc.taxes) {
			return;
		}

		if (taxes_and_charges_field) {
			return frappe.call({
				method: "erpnext.controllers.accounts_controller.get_default_taxes_and_charges",
				args: {
					"master_doctype": taxes_and_charges_field.options,
					"tax_template": me.frm.doc.taxes_and_charges,
					"company": me.frm.doc.company
				},
				callback: function(r) {
					if(!r.exc && r.message) {
						frappe.run_serially([
							() => {
								// directly set in doc, so as not to call triggers
								if(r.message.taxes_and_charges) {
									me.frm.doc.taxes_and_charges = r.message.taxes_and_charges;
								}

								// set taxes table
								if(r.message.taxes) {
									me.frm.set_value("taxes", r.message.taxes);
								}
							},
							() => me.set_dynamic_labels(),
							() => me.calculate_taxes_and_totals()
						]);
					}
				}
			});
		}
	},

	setup_sms: function() {
		var me = this;
		let blacklist_dt = ['Purchase Invoice', 'BOM'];
		let blacklist_status = in_list(["Lost", "Stopped", "Closed"], this.frm.doc.status);

		if(this.frm.doc.docstatus===1 && !blacklist_status && !blacklist_dt.includes(this.frm.doctype)) {
			this.frm.page.add_menu_item(__('Send SMS'), function() {
				me.send_sms();
			});
		}
	},

	send_sms: function() {
		var doc = this.frm.doc;
		var args = {};

		args.contact = doc.contact_person || doc.customer_primary_contact;
		args.mobile_no = doc.contact_mobile || doc.mobile_no || doc.contact_no;

		if (in_list(['Sales Order', 'Delivery Note', 'Sales Invoice'], doc.doctype)) {
			args.party_doctype = 'Customer';
			args.party = doc.bill_to || doc.customer;

		} else if (doc.doctype == 'Quotation') {
			args.party_doctype = doc.quotation_to;
			args.party = doc.party_name;

		} else if (in_list(['Purchase Order', 'Purchase Receipt'], doc.doctype)) {
			args.party_doctype = 'Supplier';
			args.party = doc.supplier;

		} else if (in_list(['Lead', 'Customer', 'Supplier'], doc.doctype)) {
			args.party_doctype = doc.doctype;
			args.party = doc.name;
		}

		new frappe.SMSManager(doc, args);
	},

	barcode: function(doc, cdt, cdn) {
		var d = locals[cdt][cdn];
		if(d.barcode=="" || d.barcode==null) {
			// barcode cleared, remove item
			d.item_code = "";
		}

		this.frm.from_barcode = true;
		this.item_code(doc, cdt, cdn);
	},

	item_code: function(doc, cdt, cdn) {
		var me = this;
		var item = frappe.get_doc(cdt, cdn);

		var update_stock = 0;
		if(['Sales Invoice'].includes(me.frm.doc.doctype)) {
			update_stock = cint(me.frm.doc.update_stock);
		}

		// clear barcode if setting item (else barcode will take priority)
		if(!me.frm.from_barcode) {
			item.barcode = null;
		}

		me.frm.from_barcode = false;
		if(item.item_code || item.barcode || item.serial_no || item.vehicle) {
			if(!me.validate_company_and_party()) {
				me.frm.fields_dict["items"].grid.grid_rows[item.idx - 1].remove();
			} else {
				return me.frm.call({
					method: "erpnext.stock.get_item_details.get_item_details",
					child: item,
					args: {
						doc: me.frm.doc,
						args: {
							item_code: item.item_code,
							hide_item_code: item.hide_item_code,
							barcode: item.barcode,
							serial_no: item.serial_no,
							vehicle: item.vehicle,
							batch_no: item.batch_no,
							set_warehouse: me.frm.doc.set_warehouse,
							default_depreciation_percentage: me.frm.doc.default_depreciation_percentage,
							warehouse: item.warehouse,
							customer: me.frm.doc.customer || me.frm.doc.party_name,
							bill_to: me.frm.doc.bill_to,
							quotation_to: me.frm.doc.quotation_to,
							supplier: me.frm.doc.supplier,
							currency: me.frm.doc.currency,
							update_stock: update_stock,
							conversion_rate: me.frm.doc.conversion_rate,
							price_list: me.frm.doc.selling_price_list || me.frm.doc.buying_price_list,
							price_list_currency: me.frm.doc.price_list_currency,
							plc_conversion_rate: me.frm.doc.plc_conversion_rate,
							company: me.frm.doc.company,
							order_type: me.frm.doc.order_type,
							transaction_type_name: me.frm.doc.transaction_type,
							is_pos: cint(me.frm.doc.is_pos),
							is_subcontracted: me.frm.doc.is_subcontracted,
							transaction_date: me.frm.doc.transaction_date || me.frm.doc.posting_date,
							ignore_pricing_rule: me.frm.doc.ignore_pricing_rule,
							doctype: me.frm.doc.doctype,
							name: me.frm.doc.name,
							project: item.project || me.frm.doc.project,
							campaign: me.frm.doc.campaign,
							qty: item.qty || 1,
							stock_qty: item.stock_qty,
							weight_per_unit: item.weight_per_unit,
							weight_uom: item.weight_uom,
							manufacturer: item.manufacturer,
							stock_uom: item.stock_uom,
							pos_profile: me.frm.doc.doctype == 'Sales Invoice' ? me.frm.doc.pos_profile : '',
							cost_center: item.cost_center,
							apply_discount_after_taxes: item.apply_discount_after_taxes,
							allow_zero_valuation_rate: item.allow_zero_valuation_rate,
							tax_category: me.frm.doc.tax_category,
							child_docname: item.name,
						}
					},

					callback: function(r) {
						if(!r.exc) {
							frappe.run_serially([
								() => {
									var d = locals[cdt][cdn];
									me.add_taxes_from_item_tax_template(d.item_tax_rate);
									if (d.free_item_data) {
										me.apply_product_discount(d.free_item_data);
									}
								},
								() => me.frm.script_manager.trigger("price_list_rate", cdt, cdn),
								() => me.toggle_conversion_factor(item),
								() => me.conversion_factor(doc, cdt, cdn, true),
								() => me.show_hide_select_batch_button && me.show_hide_select_batch_button(),
								() => me.set_skip_delivery_note && me.set_skip_delivery_note(),
								() => me.remove_pricing_rule(item),
								() => {
									if (item.apply_rule_on_other_items) {
										let key = item.name;
										me.apply_rule_on_other_items({key: item});
									}
								}
							]);
						}
					}
				});
			}
		}
	},

	add_taxes_from_item_tax_template: function(item_tax_map) {
		let me = this;

		if(item_tax_map && cint(frappe.defaults.get_default("add_taxes_from_item_tax_template"))) {
			if(typeof (item_tax_map) == "string") {
				item_tax_map = JSON.parse(item_tax_map);
			}

			$.each(item_tax_map, function(tax, rate) {
				let found = (me.frm.doc.taxes || []).find(d => d.account_head === tax);
				if(!found) {
					let child = frappe.model.add_child(me.frm.doc, "taxes");
					child.charge_type = "On Net Total";
					child.account_head = tax;
					child.rate = 0;
				}
			});
		}
	},

	serial_no: function(doc, cdt, cdn) {
		var me = this;
		var item = frappe.get_doc(cdt, cdn);

		if (item && item.serial_no) {
			if (!item.item_code) {
				this.frm.trigger("item_code", cdt, cdn);
			}
			else {
				var valid_serial_nos = [];

				// Replacing all occurences of comma with carriage return
				var serial_nos = item.serial_no.trim().replace(/,/g, '\n');

				serial_nos = serial_nos.trim().split('\n');

				// Trim each string and push unique string to new list
				for (var x=0; x<=serial_nos.length - 1; x++) {
					if (serial_nos[x].trim() != "" && valid_serial_nos.indexOf(serial_nos[x].trim()) == -1) {
						valid_serial_nos.push(serial_nos[x].trim());
					}
				}

				// Add the new list to the serial no. field in grid with each in new line
				item.serial_no = valid_serial_nos.join('\n');
				item.conversion_factor = item.conversion_factor || 1;

				refresh_field("serial_no", item.name, item.parentfield);
				if(!doc.is_return && cint(user_defaults.set_qty_in_transactions_based_on_serial_no_input)) {
					frappe.model.set_value(item.doctype, item.name,
						"qty", valid_serial_nos.length / item.conversion_factor);
					frappe.model.set_value(item.doctype, item.name, "stock_qty", valid_serial_nos.length);
				}
			}
		}
	},

	vehicle: function(doc, cdt, cdn) {
		var item = frappe.get_doc(cdt, cdn);

		if (item && item.vehicle && !item.item_code) {
			this.frm.trigger("item_code", cdt, cdn);
		}
	},

	apply_discount_after_taxes: function() {
		this.set_dynamic_labels();
		this.calculate_taxes_and_totals();
	},

	validate: function() {
		this.calculate_taxes_and_totals(false);
	},

	company: function() {
		this.set_company_defaults(true);
	},

	set_company_defaults: function (reset_account) {
		var me = this;
		var set_pricing = function() {
			if(me.frm.doc.company && me.frm.fields_dict.currency) {
				var company_currency = me.get_company_currency();
				var company_doc = frappe.get_doc(":Company", me.frm.doc.company);

				if (!me.frm.doc.currency) {
					me.frm.set_value("currency", company_currency);
				}

				if (me.frm.doc.currency == company_currency) {
					me.frm.set_value("conversion_rate", 1.0);
				}
				if (me.frm.doc.price_list_currency == company_currency) {
					me.frm.set_value('plc_conversion_rate', 1.0);
				}
				if (company_doc.default_letter_head) {
					if(me.frm.fields_dict.letter_head) {
						me.frm.set_value("letter_head", company_doc.default_letter_head);
					}
				}
				let selling_doctypes_for_tc = ["Sales Invoice", "Quotation", "Sales Order", "Delivery Note"];
				if (company_doc.default_selling_terms && frappe.meta.has_field(me.frm.doc.doctype, "tc_name") &&
				selling_doctypes_for_tc.indexOf(me.frm.doc.doctype) != -1) {
					me.frm.set_value("tc_name", company_doc.default_selling_terms);
				}
				let buying_doctypes_for_tc = ["Request for Quotation", "Supplier Quotation", "Purchase Order",
					"Material Request", "Purchase Receipt"];
				// Purchase Invoice is excluded as per issue #3345
				if (company_doc.default_buying_terms && frappe.meta.has_field(me.frm.doc.doctype, "tc_name") &&
				buying_doctypes_for_tc.indexOf(me.frm.doc.doctype) != -1) {
					me.frm.set_value("tc_name", company_doc.default_buying_terms);
				}

				frappe.run_serially([
					() => me.frm.script_manager.trigger("currency"),
					() => me.update_item_tax_map(),
					() => me.apply_default_taxes(),
					() => me.apply_pricing_rule()
				]);
			}
		}

		var set_party_account = function(set_pricing) {
			if (in_list(["Sales Invoice", "Purchase Invoice"], me.frm.doc.doctype)) {
				if(me.frm.doc.doctype=="Sales Invoice") {
					var party_type = "Customer";
					var party_account_field = 'debit_to';
				} else {
					var party_type = me.frm.doc.letter_of_credit ? "Letter of Credit" : "Supplier";
					var party_account_field = 'credit_to';
				}

				var party = me.frm.doc.bill_to || me.frm.doc[frappe.model.scrub(party_type)];
				if(party && me.frm.doc.company) {
					return frappe.call({
						method: "erpnext.accounts.party.get_party_account_details",
						args: {
							company: me.frm.doc.company,
							party_type: party_type,
							party: party,
							transaction_type: me.frm.doc.transaction_type
						},
						callback: function(r) {
							if(!r.exc && r.message) {
								if (reset_account || !me.frm.doc[party_account_field]) {
									me.frm.set_value(party_account_field, r.message.account);
								}
								if (r.message.cost_center && (reset_account || !me.frm.doc.cost_center)) {
									me.frm.set_value("cost_center", r.message.cost_center);
								}
								set_pricing();
							}
						}
					});
				} else {
					set_pricing();
				}
			} else {
				set_pricing();
			}

		}

		if (this.frm.doc.posting_date) var date = this.frm.doc.posting_date;
		else var date = this.frm.doc.transaction_date;

		if (frappe.meta.get_docfield(this.frm.doctype, "shipping_address") &&
			in_list(['Purchase Order', 'Purchase Receipt', 'Purchase Invoice'], this.frm.doctype)){
			erpnext.utils.get_shipping_address(this.frm, function(){
				set_party_account(set_pricing);
			})
		} else {
			set_party_account(set_pricing);
		}

		this.update_item_defaults(false);

		if(this.frm.doc.company) {
			erpnext.last_selected_company = this.frm.doc.company;
		}
	},

	transaction_date: function() {
		if (this.frm.doc.transaction_date) {
			this.frm.transaction_date = this.frm.doc.transaction_date;
			frappe.ui.form.trigger(this.frm.doc.doctype, "currency");
		}
	},

	posting_date: function() {
		var me = this;
		if (this.frm.doc.posting_date) {
			this.frm.posting_date = this.frm.doc.posting_date;

			if ((this.frm.doc.doctype == "Sales Invoice" && this.frm.doc.customer) ||
				(this.frm.doc.doctype == "Purchase Invoice" && this.frm.doc.supplier)) {
				return frappe.call({
					method: "erpnext.accounts.party.get_due_date",
					args: {
						"posting_date": me.frm.doc.posting_date,
						"party_type": me.frm.doc.doctype == "Sales Invoice" ? "Customer" : "Supplier",
						"bill_date": me.frm.doc.bill_date,
						"party": me.frm.doc.doctype == "Sales Invoice" ? me.frm.doc.customer : me.frm.doc.supplier,
						"company": me.frm.doc.company
					},
					callback: function(r, rt) {
						if(r.message) {
							me.frm.doc.due_date = r.message;
							refresh_field("due_date");
							frappe.ui.form.trigger(me.frm.doc.doctype, "currency");
							me.recalculate_terms();
						}
					}
				})
			} else {
				frappe.ui.form.trigger(me.frm.doc.doctype, "currency");
			}
		}
	},

	due_date: function() {
		// due_date is to be changed, payment terms template and/or payment schedule must
		// be removed as due_date is automatically changed based on payment terms
		if (this.frm.doc.due_date && !this.frm.updating_party_details && !this.frm.doc.is_pos) {
			if (this.frm.doc.payment_terms_template ||
				(this.frm.doc.payment_schedule && this.frm.doc.payment_schedule.length)) {
				var message1 = "";
				var message2 = "";
				var final_message = "Please clear the ";

				if (this.frm.doc.payment_terms_template) {
					message1 = "selected Payment Terms Template";
					final_message = final_message + message1;
				}

				if ((this.frm.doc.payment_schedule || []).length) {
					message2 = "Payment Schedule Table";
					if (message1.length !== 0) message2 = " and " + message2;
					final_message = final_message + message2;
				}
				frappe.msgprint(final_message);
			}
		}
	},

	bill_date: function() {
		this.posting_date();
	},

	recalculate_terms: function() {
		const doc = this.frm.doc;
		if (doc.payment_terms_template) {
			this.payment_terms_template();
		} else if (doc.payment_schedule) {
			const me = this;
			doc.payment_schedule.forEach(
				function(term) {
					if (term.payment_term) {
						me.payment_term(doc, term.doctype, term.name);
					} else {
						frappe.model.set_value(
							term.doctype, term.name, 'due_date',
							doc.posting_date || doc.transaction_date
						);
					}
				}
			);
		}
	},

	get_company_currency: function() {
		return erpnext.get_currency(this.frm.doc.company);
	},

	contact_person: function() {
		erpnext.utils.get_contact_details(this.frm);
	},

	currency: function() {
		/* manqala 19/09/2016: let the translation date be whichever of the transaction_date or posting_date is available */
		var transaction_date = this.frm.doc.transaction_date || this.frm.doc.posting_date;
		/* end manqala */
		var me = this;
		this.set_dynamic_labels();
		var company_currency = this.get_company_currency();
		// Added `ignore_pricing_rule` to determine if document is loading after mapping from another doc
		if(this.frm.doc.currency && this.frm.doc.currency !== company_currency
				&& !this.frm.doc.ignore_pricing_rule) {

			this.get_exchange_rate(transaction_date, this.frm.doc.currency, company_currency,
				function(exchange_rate) {
					if(exchange_rate != me.frm.doc.conversion_rate) {
						// me.set_margin_amount_based_on_currency(exchange_rate);
						// me.set_actual_charges_based_on_currency(exchange_rate);
						me.frm.set_value("conversion_rate", exchange_rate);
					}
				});
		} else {
			this.conversion_rate();
		}
	},

	conversion_rate: function() {
		const me = this.frm;
		if(this.frm.doc.currency === this.get_company_currency()) {
			this.frm.set_value("conversion_rate", 1.0);
		}
		if(this.frm.doc.currency === this.frm.doc.price_list_currency &&
			this.frm.doc.plc_conversion_rate &&
			this.frm.doc.plc_conversion_rate !== this.frm.doc.conversion_rate) {
			this.frm.set_value("plc_conversion_rate", this.frm.doc.conversion_rate);
		}

		if(flt(this.frm.doc.conversion_rate)>0.0) {
			if (cint(this.frm.doc.calculate_tax_on_company_currency)) {
				this.set_actual_charges_based_on_company_currency();
			}

			this.calculate_taxes_and_totals();
		}
		// Make read only if Accounts Settings doesn't allow stale rates
		this.frm.set_df_property("conversion_rate", "read_only", erpnext.stale_rate_allowed() ? 0 : 1);
	},

	shipping_rule: function() {
		var me = this;
		if(this.frm.doc.shipping_rule) {
			return this.frm.call({
				doc: this.frm.doc,
				method: "apply_shipping_rule",
				callback: function(r) {
					if(!r.exc) {
						me.calculate_taxes_and_totals();
					}
				}
			}).fail(() => this.frm.set_value('shipping_rule', ''));
		}
		else {
			me.calculate_taxes_and_totals();
		}
	},

	set_margin_amount_based_on_currency: function(exchange_rate) {
		if (in_list(["Quotation", "Sales Order", "Delivery Note", "Sales Invoice"], this.frm.doc.doctype)) {
			var me = this;
			$.each(this.frm.doc.items || [], function(i, d) {
				if(d.margin_type == "Amount") {
					frappe.model.set_value(d.doctype, d.name, "margin_rate_or_amount",
						flt(d.margin_rate_or_amount) / flt(exchange_rate));
				}
			});
		}
	},

	set_actual_charges_based_on_currency: function(exchange_rate) {
		var me = this;
		$.each(this.frm.doc.taxes || [], function(i, d) {
			if(d.charge_type == "Actual") {
				frappe.model.set_value(d.doctype, d.name, "tax_amount",
					flt(d.tax_amount) / flt(exchange_rate));
			}
		});
	},

	set_actual_charges_based_on_company_currency: function() {
		var me = this;
		$.each(this.frm.doc.taxes || [], function(i, d) {
			if(d.charge_type == "Actual" || d.charge_type == "Weighted Distribution") {
				d.tax_amount = flt(d.base_tax_amount) / flt(me.frm.doc.conversion_rate);
			}
		});
	},

	get_exchange_rate: function(transaction_date, from_currency, to_currency, callback) {
		var args;
		if (["Quotation", "Sales Order", "Delivery Note", "Sales Invoice"].includes(this.frm.doctype)) {
			args = "for_selling";
		}
		else if (["Purchase Order", "Purchase Receipt", "Purchase Invoice"].includes(this.frm.doctype)) {
			args = "for_buying";
		}

		if (!transaction_date || !from_currency || !to_currency) return;
		return frappe.call({
			method: "erpnext.setup.utils.get_exchange_rate",
			args: {
				transaction_date: transaction_date,
				from_currency: from_currency,
				to_currency: to_currency,
				args: args
			},
			callback: function(r) {
				callback(flt(r.message));
			}
		});
	},

	price_list_currency: function() {
		var me=this;
		this.set_dynamic_labels();

		var company_currency = this.get_company_currency();
		// Added `ignore_pricing_rule` to determine if document is loading after mapping from another doc
		if(this.frm.doc.price_list_currency !== company_currency  && !this.frm.doc.ignore_pricing_rule) {
			this.get_exchange_rate(this.frm.doc.posting_date, this.frm.doc.price_list_currency, company_currency,
				function(exchange_rate) {
					me.frm.set_value("plc_conversion_rate", exchange_rate);
				});
		} else {
			this.plc_conversion_rate();
		}
	},

	plc_conversion_rate: function() {
		if(this.frm.doc.price_list_currency === this.get_company_currency()) {
			this.frm.set_value("plc_conversion_rate", 1.0);
		} else if(this.frm.doc.price_list_currency === this.frm.doc.currency
			&& this.frm.doc.plc_conversion_rate && cint(this.frm.doc.plc_conversion_rate) != 1 &&
			cint(this.frm.doc.plc_conversion_rate) != cint(this.frm.doc.conversion_rate)) {
			this.frm.set_value("conversion_rate", this.frm.doc.plc_conversion_rate);
		}
	},

	uom: function(doc, cdt, cdn) {
		var me = this;
		var item = frappe.get_doc(cdt, cdn);
		if(item.item_code && item.uom) {
			return this.frm.call({
				method: "erpnext.stock.get_item_details.get_conversion_factor",
				child: item,
				args: {
					item_code: item.item_code,
					uom: item.uom
				},
				callback: function(r) {
					if(!r.exc) {
						me.conversion_factor(me.frm.doc, cdt, cdn);
					}
				}
			});
		}
	},

	conversion_factor: function(doc, cdt, cdn, dont_fetch_price_list_rate) {
		if(frappe.meta.get_docfield(cdt, "stock_qty", cdn)) {
			var item = frappe.get_doc(cdt, cdn);
			frappe.model.round_floats_in(item, ["qty", "conversion_factor"]);
			item.stock_qty = flt(item.qty * item.conversion_factor, precision("stock_qty", item));
			refresh_field("stock_qty", item.name, item.parentfield);
			this.toggle_conversion_factor(item);

			if(frappe.meta.get_docfield(cdt, "alt_uom_size", cdn)) {
				if (!item.alt_uom) {
					item.alt_uom_size = 1.0
				}
				item.alt_uom_qty = flt(item.qty * item.conversion_factor * item.alt_uom_size, precision("alt_uom_qty", item));
				refresh_field("alt_uom_qty", item.name, item.parentfield);
			}

			if(doc.doctype != "Material Request") {
				item.total_weight = flt(item.stock_qty * item.weight_per_unit);
				refresh_field("total_weight", item.name, item.parentfield);
				this.calculate_net_weight();
			} else {
				this.calculate_total_qty();
			}

			if (!dont_fetch_price_list_rate &&
				frappe.meta.has_field(doc.doctype, "price_list_currency")) {
				this.apply_price_list(item, true);
			}
		}
	},

	toggle_conversion_factor: function(item) {
		// toggle read only property for conversion factor field if the uom and stock uom are same
		if(this.frm.get_field('items').grid.fields_map.conversion_factor) {
			this.frm.fields_dict.items.grid.toggle_enable("conversion_factor",
				((item.uom != item.stock_uom) && !frappe.meta.get_docfield(cur_frm.fields_dict.items.grid.doctype, "conversion_factor").read_only)? true: false);
		}

	},

	tax_exclusive_rate: function(doc, cdt, cdn) {
		var item = locals[cdt][cdn];
		frappe.model.set_value(cdt, cdn, "rate", item.tax_exclusive_rate * (1 + item.cumulated_tax_fraction));
	},

	qty: function(doc, cdt, cdn) {
		let item = frappe.get_doc(cdt, cdn);
		this.conversion_factor(doc, cdt, cdn, true);
		this.apply_pricing_rule(item, true);
	},

	service_stop_date: function(frm, cdt, cdn) {
		var child = locals[cdt][cdn];

		if(child.service_stop_date) {
			let start_date = Date.parse(child.service_start_date);
			let end_date = Date.parse(child.service_end_date);
			let stop_date = Date.parse(child.service_stop_date);

			if(stop_date < start_date) {
				frappe.model.set_value(cdt, cdn, "service_stop_date", "");
				frappe.throw(__("Service Stop Date cannot be before Service Start Date"));
			} else if (stop_date > end_date) {
				frappe.model.set_value(cdt, cdn, "service_stop_date", "");
				frappe.throw(__("Service Stop Date cannot be after Service End Date"));
			}
		}
	},

	service_start_date: function(frm, cdt, cdn) {
		var child = locals[cdt][cdn];

		if(child.service_start_date) {
			frappe.call({
				"method": "erpnext.stock.get_item_details.calculate_service_end_date",
				args: {"args": child},
				callback: function(r) {
					frappe.model.set_value(cdt, cdn, "service_end_date", r.message.service_end_date);
				}
			})
		}
	},

	applies_to_item: function () {
		this.get_applies_to_details();
	},
	applies_to_vehicle: function () {
		this.set_applies_to_read_only();
		this.get_applies_to_details();
	},
	vehicle_owner: function () {
		if (!this.frm.doc.vehicle_owner) {
			this.frm.doc.vehicle_owner_name = null;
		}
	},

	vehicle_chassis_no: function () {
		erpnext.utils.format_vehicle_id(this.frm, 'vehicle_chassis_no');
	},
	vehicle_engine_no: function () {
		erpnext.utils.format_vehicle_id(this.frm, 'vehicle_engine_no');
	},
	vehicle_license_plate: function () {
		erpnext.utils.format_vehicle_id(this.frm, 'vehicle_license_plate');
	},

	get_applies_to_details: function () {
		var me = this;
		var args = this.get_applies_to_args();
		return frappe.call({
			method: "erpnext.stock.get_item_details.get_applies_to_details",
			args: {
				args: args
			},
			callback: function(r) {
				if(!r.exc) {
					return me.frm.set_value(r.message);
				}
			}
		});
	},

	get_applies_to_vehicle_odometer: function () {
		if (!this.frm.doc.applies_to_vehicle || !this.frm.fields_dict.vehicle_last_odometer) {
			return;
		}

		var me = this;
		return frappe.call({
			method: "erpnext.stock.get_item_details.get_applies_to_vehicle_odometer",
			args: {
				vehicle: this.frm.doc.applies_to_vehicle,
				project: this.frm.doc.project,
			},
			callback: function(r) {
				if(!r.exc) {
					me.frm.set_value('vehicle_last_odometer', r.message);
				}
			}
		});
	},

	get_applies_to_args: function () {
		return {
			applies_to_item: this.frm.doc.applies_to_item,
			applies_to_vehicle: this.frm.doc.applies_to_vehicle,
			doctype: this.frm.doc.doctype,
			name: this.frm.doc.name,
			project: this.frm.doc.project,
		}
	},

	set_applies_to_read_only: function() {
		var me = this;
		var read_only_fields = [
			'applies_to_item', 'applies_to_item_name',
			'vehicle_license_plate', 'vehicle_unregistered',
			'vehicle_chassis_no', 'vehicle_engine_no',
			'vehicle_color', 'vehicle_last_odometer',
		];
		$.each(read_only_fields, function (i, f) {
			if (me.frm.fields_dict[f]) {
				me.frm.set_df_property(f, "read_only", me.frm.doc.applies_to_vehicle ? 1 : 0);
			}
		});
	},

	calculate_net_weight: function(){
		/* Calculate Total Net Weight then further applied shipping rule to calculate shipping charges.*/
		var me = this;
		this.frm.doc.total_net_weight= 0.0;

		$.each(this.frm.doc["items"] || [], function(i, item) {
			me.frm.doc.total_net_weight += flt(item.total_weight);
		});
		refresh_field("total_net_weight");
		this.shipping_rule();
	},

	set_dynamic_labels: function() {
		// What TODO? should we make price list system non-mandatory?
		this.frm.toggle_reqd("plc_conversion_rate",
			!!(this.frm.doc.price_list_name && this.frm.doc.price_list_currency));

		var company_currency = this.get_company_currency();
		this.change_form_labels(company_currency);
		this.change_grid_labels(company_currency);
		this.frm.refresh_fields();
	},

	change_form_labels: function(company_currency) {
		var me = this;

		this.frm.set_currency_labels(["base_total", "base_net_total", "base_taxable_total",
			"base_total_taxes_and_charges", "base_total_discount_after_taxes", "base_total_after_taxes",
			"base_discount_amount", "base_grand_total", "base_rounded_total", "base_in_words",
			"base_taxes_and_charges_added", "base_taxes_and_charges_deducted", "total_amount_to_pay",
			"base_paid_amount", "base_write_off_amount", "base_change_amount", "base_operating_cost",
			"base_raw_material_cost", "base_total_cost", "base_scrap_material_cost",
			"base_total_operating_cost", "base_additional_operating_cost",
			"base_rounding_adjustment", "base_tax_exclusive_total",
			"base_total_before_discount", "base_tax_exclusive_total_before_discount",
			"base_total_discount", "base_tax_exclusive_total_discount",
			"base_total_depreciation", "base_tax_exclusive_total_depreciation",
			"base_total_before_depreciation", "base_tax_exclusive_total_before_depreciation"], company_currency);

		this.frm.set_currency_labels(["total", "net_total", "taxable_total", "total_taxes_and_charges",
			"discount_amount", "grand_total", "total_discount_after_taxes", "total_after_taxes",
			"taxes_and_charges_added", "taxes_and_charges_deducted",
			"rounded_total", "in_words", "paid_amount", "write_off_amount", "change_amount", "operating_cost",
			"scrap_material_cost", "rounding_adjustment", "raw_material_cost",
			"total_operating_cost", "additional_operating_cost",
			"total_cost", "tax_exclusive_total",
			"total_before_discount", "tax_exclusive_total_before_discount",
			"total_discount", "tax_exclusive_total_discount",
			"total_depreciation", "tax_exclusive_total_depreciation",
			"total_before_depreciation", "tax_exclusive_total_before_depreciation"], this.frm.doc.currency);

		if (this.frm.doc.doctype === "Sales Invoice") {
			this.frm.set_currency_labels(["customer_outstanding_amount", "previous_outstanding_amount"],
				this.frm.doc.party_account_currency);
		} else {
			this.frm.set_currency_labels(["customer_outstanding_amount", "customer_credit_limit",
				"customer_credit_balance"], company_currency);
		}

		this.frm.set_currency_labels(["outstanding_amount", "total_advance"],
			this.frm.doc.party_account_currency);

		cur_frm.set_df_property("conversion_rate", "description", "1 " + this.frm.doc.currency
			+ " = [?] " + company_currency);

		if(this.frm.doc.price_list_currency && this.frm.doc.price_list_currency!=company_currency) {
			cur_frm.set_df_property("plc_conversion_rate", "description", "1 "
				+ this.frm.doc.price_list_currency + " = [?] " + company_currency);
		}

		// toggle fields
		this.frm.toggle_display(["conversion_rate", "base_total", "base_net_total", "base_taxable_total",
			"base_total_discount_after_taxes", "base_total_after_taxes",
			"base_total_taxes_and_charges", "base_taxes_and_charges_added", "base_taxes_and_charges_deducted",
			"base_grand_total", "base_rounded_total", "base_in_words",
			"base_paid_amount", "base_change_amount", "base_write_off_amount", "base_operating_cost", "base_raw_material_cost",
			"base_total_operating_cost", "base_additional_operating_cost",
			"base_total_cost", "base_scrap_material_cost", "base_rounding_adjustment",
			"base_total_before_discount", "base_total_discount",
			"base_total_depreciation", "base_total_before_depreciation",
			"calculate_tax_on_company_currency"],
		this.frm.doc.currency != company_currency, true);

		this.frm.toggle_display(["plc_conversion_rate", "price_list_currency"],
			this.frm.doc.price_list_currency != company_currency, true);

		var show_exclusive = (cur_frm.doc.taxes || []).filter(function(d) {return d.included_in_print_rate===1}).length;

		$.each(["tax_exclusive_total", "tax_exclusive_total_before_discount", "tax_exclusive_total_discount",
		"tax_exclusive_total_before_depreciation", "tax_exclusive_total_depreciation"], function(i, fname) {
			if(frappe.meta.get_docfield(cur_frm.doctype, fname))
				cur_frm.toggle_display(fname, show_exclusive, true);
		});

		$.each(["base_tax_exclusive_total", "base_tax_exclusive_total_before_discount",
		"base_tax_exclusive_total_discount",
		"base_tax_exclusive_total_before_depreciation", "base_tax_exclusive_total_depreciation"], function(i, fname) {
			if(frappe.meta.get_docfield(cur_frm.doctype, fname))
				cur_frm.toggle_display(fname, show_exclusive && (me.frm.doc.currency != company_currency), true);
		});

		var apply_discount_after_taxes = (cur_frm.doc.items || []).filter(d => cint(d.apply_discount_after_taxes)).length
			&& (cur_frm.doc.taxes || []).filter(d => d.tax_amount).length;
		var show_net = cint(cur_frm.doc.discount_amount) || apply_discount_after_taxes || show_exclusive;

		if(frappe.meta.get_docfield(cur_frm.doctype, "net_total"))
			cur_frm.toggle_display("net_total", show_net, true);

		if(frappe.meta.get_docfield(cur_frm.doctype, "base_net_total"))
			cur_frm.toggle_display("base_net_total", (show_net && (me.frm.doc.currency != company_currency)), true);

		$.each(["base_discount_amount"], function(i, fname) {
			if(frappe.meta.get_docfield(cur_frm.doctype, fname))
				cur_frm.toggle_display(fname, me.frm.doc.currency != company_currency, true);
		});
	},

	change_grid_labels: function(company_currency) {
		var me = this;

		this.frm.set_currency_labels(["base_price_list_rate", "base_rate", "base_net_rate", "base_taxable_rate",
				"base_amount", "base_net_amount", "base_taxable_amount",
				"base_rate_with_margin", "base_tax_exclusive_price_list_rate",
				"base_tax_exclusive_rate", "base_tax_exclusive_amount", "base_tax_exclusive_rate_with_margin",
				"base_amount_before_discount", "base_tax_exclusive_amount_before_discount",
				"base_item_taxes_and_charges", "base_tax_inclusive_amount", "base_tax_inclusive_rate",
				"base_total_discount", "base_tax_exclusive_total_discount",
				"base_depreciation_amount", "base_amount_before_depreciation",
				"base_tax_exclusive_depreciation_amount", "base_tax_exclusive_amount_before_depreciation",
				"base_returned_amount"],
			company_currency, "items");

		this.frm.set_currency_labels(["price_list_rate", "rate", "net_rate", "taxable_rate",
				"amount", "net_amount", "taxable_amount", "rate_with_margin",
				"discount_amount", "tax_exclusive_price_list_rate", "tax_exclusive_rate", "tax_exclusive_amount",
				"tax_exclusive_discount_amount", "tax_exclusive_rate_with_margin",
				"amount_before_discount", "tax_exclusive_amount_before_discount",
				"total_discount", "tax_exclusive_total_discount",
				"depreciation_amount", "amount_before_depreciation",
				"tax_exclusive_depreciation_amount", "tax_exclusive_amount_before_depreciation"],
			this.frm.doc.currency, "items");

		if(this.frm.fields_dict["operations"]) {
			this.frm.set_currency_labels(["operating_cost", "hour_rate"], this.frm.doc.currency, "operations");
			this.frm.set_currency_labels(["base_operating_cost", "base_hour_rate"], company_currency, "operations");

			var item_grid = this.frm.fields_dict["operations"].grid;
			$.each(["base_operating_cost", "base_hour_rate"], function(i, fname) {
				if(frappe.meta.get_docfield(item_grid.doctype, fname))
					item_grid.set_column_disp(fname, me.frm.doc.currency != company_currency, true);
			});
		}

		if(this.frm.fields_dict["scrap_items"]) {
			this.frm.set_currency_labels(["rate", "amount"], this.frm.doc.currency, "scrap_items");
			this.frm.set_currency_labels(["base_rate", "base_amount"], company_currency, "scrap_items");

			var item_grid = this.frm.fields_dict["scrap_items"].grid;
			$.each(["base_rate", "base_amount"], function(i, fname) {
				if(frappe.meta.get_docfield(item_grid.doctype, fname))
					item_grid.set_column_disp(fname, me.frm.doc.currency != company_currency, true);
			});
		}

		if(this.frm.fields_dict["additional_costs"]) {
			this.frm.set_currency_labels(["rate", "amount"], this.frm.doc.currency, "additional_costs");
			this.frm.set_currency_labels(["base_rate", "base_amount"], company_currency, "additional_costs");

			var additional_costs_grid = this.frm.fields_dict["additional_costs"].grid;
			$.each(["base_rate", "base_amount"], function(i, fname) {
				if(frappe.meta.get_docfield(additional_costs_grid.doctype, fname))
					additional_costs_grid.set_column_disp(fname, me.frm.doc.currency != company_currency, true);
			});
		}

		if(this.frm.fields_dict["taxes"]) {
			this.frm.set_currency_labels(["tax_amount", "total", "tax_amount_after_discount_amount",
				"displayed_total"], this.frm.doc.currency, "taxes");

			this.frm.set_currency_labels(["base_tax_amount", "base_total", "base_tax_amount_after_discount_amount",
				"base_displayed_total"], company_currency, "taxes");
		}

		if(this.frm.fields_dict["advances"]) {
			this.frm.set_currency_labels(["advance_amount", "allocated_amount"],
				this.frm.doc.party_account_currency, "advances");
		}

		// toggle columns
		if(this.frm.fields_dict["taxes"]) {
			var tax_grid = this.frm.fields_dict["taxes"].grid;
			$.each(["base_tax_amount", "base_total", "base_tax_amount_after_discount_amount",
			"base_displayed_total"], function(i, fname) {
				if(frappe.meta.get_docfield(tax_grid.doctype, fname))
					tax_grid.set_column_disp(fname, me.frm.doc.currency != company_currency, true);
			});
		}

		var item_grid = this.frm.fields_dict["items"].grid;
		$.each(["base_rate", "base_price_list_rate", "base_amount", "base_rate_with_margin",
		"base_amount_before_discount", "base_total_discount", "base_depreciation_amount", "base_amount_before_depreciation",
		"base_item_taxes_and_charges", "base_tax_inclusive_amount", "base_tax_inclusive_rate"], function(i, fname) {
			if(frappe.meta.get_docfield(item_grid.doctype, fname))
				item_grid.set_column_disp(fname, me.frm.doc.currency != company_currency, true);
		});

		var show_exclusive = (cur_frm.doc.taxes || []).filter(function(d) {return d.included_in_print_rate===1}).length;

		$.each(["tax_exclusive_price_list_rate", "tax_exclusive_rate", "tax_exclusive_amount",
		"tax_exclusive_discount_amount", "tax_exclusive_rate_with_margin",
		"tax_exclusive_amount_before_discount", "tax_exclusive_total_discount",
		"tax_exclusive_amount_before_depreciation", "tax_exclusive_depreciation_amount"], function(i, fname) {
			if(frappe.meta.get_docfield(item_grid.doctype, fname))
				item_grid.set_column_disp(fname, show_exclusive, true);
		});

		$.each(["base_tax_exclusive_price_list_rate", "base_tax_exclusive_rate", "base_tax_exclusive_amount",
		"base_tax_exclusive_rate_with_margin",
		"base_tax_exclusive_amount_before_discount", "base_tax_exclusive_total_discount",
		"base_tax_exclusive_amount_before_depreciation", "base_tax_exclusive_depreciation_amount"], function(i, fname) {
			if(frappe.meta.get_docfield(item_grid.doctype, fname))
				item_grid.set_column_disp(fname, (show_exclusive && (me.frm.doc.currency != company_currency)), true);
		});

		var apply_discount_after_taxes = (cur_frm.doc.items || []).filter(d => cint(d.apply_discount_after_taxes)).length;
		var show_net = cint(cur_frm.doc.discount_amount) || apply_discount_after_taxes || show_exclusive;

		$.each(["taxable_rate", "taxable_amount", "net_rate", "net_amount"], function(i, fname) {
			if(frappe.meta.get_docfield(item_grid.doctype, fname))
				item_grid.set_column_disp(fname, show_net, true);
		});

		$.each(["base_taxable_rate", "base_taxable_amount", "base_net_rate", "base_net_amount"], function(i, fname) {
			if(frappe.meta.get_docfield(item_grid.doctype, fname))
				item_grid.set_column_disp(fname, (show_net && (me.frm.doc.currency != company_currency)), true);
		});

		// set labels
		var $wrapper = $(this.frm.wrapper);
	},

	recalculate: function() {
		this.calculate_taxes_and_totals();
	},

	recalculate_values: function() {
		this.calculate_taxes_and_totals();
	},

	calculate_charges: function() {
		this.calculate_taxes_and_totals();
	},

	disable_rounded_total: function () {
		this.calculate_taxes_and_totals();
	},

	ignore_pricing_rule: function() {
		if(this.frm.doc.ignore_pricing_rule) {
			var me = this;
			var item_list = [];

			$.each(this.frm.doc["items"] || [], function(i, d) {
				if (d.item_code && !d.is_free_item) {
					item_list.push({
						"doctype": d.doctype,
						"name": d.name,
						"item_code": d.item_code,
						"pricing_rules": d.pricing_rules,
						"parenttype": d.parenttype,
						"parent": d.parent
					})
				}
			});
			return this.frm.call({
				method: "erpnext.accounts.doctype.pricing_rule.pricing_rule.remove_pricing_rules",
				args: { item_list: item_list },
				callback: function(r) {
					if (!r.exc && r.message) {
						r.message.forEach(row_item => {
							me.remove_pricing_rule(row_item);
						});
						me._set_values_for_item_list(r.message);
						me.calculate_taxes_and_totals();
						if(me.frm.doc.apply_discount_on) me.frm.trigger("apply_discount_on");
					}
				}
			});
		} else {
			this.apply_pricing_rule();
		}
	},

	apply_pricing_rule: function(item, calculate_taxes_and_totals) {
		var me = this;
		var args = this._get_args(item);
		if (!(args.items && args.items.length)) {
			if(calculate_taxes_and_totals) me.calculate_taxes_and_totals();
			return;
		}

		return this.frm.call({
			method: "erpnext.accounts.doctype.pricing_rule.pricing_rule.apply_pricing_rule",
			args: {	args: args, doc: me.frm.doc },
			callback: function(r) {
				if (!r.exc && r.message) {
					me._set_values_for_item_list(r.message);
					if(item) me.set_gross_profit(item);
					if(me.frm.doc.apply_discount_on) me.frm.trigger("apply_discount_on")
				}
			}
		});
	},

	_get_args: function(item) {
		var me = this;
		return {
			"items": this._get_item_list(item),
			"customer": me.frm.doc.customer || me.frm.doc.party_name,
			"bill_to": me.frm.doc.bill_to,
			"quotation_to": me.frm.doc.quotation_to,
			"customer_group": me.frm.doc.customer_group,
			"territory": me.frm.doc.territory,
			"supplier": me.frm.doc.supplier,
			"supplier_group": me.frm.doc.supplier_group,
			"currency": me.frm.doc.currency,
			"conversion_rate": me.frm.doc.conversion_rate,
			"price_list": me.frm.doc.selling_price_list || me.frm.doc.buying_price_list,
			"price_list_currency": me.frm.doc.price_list_currency,
			"plc_conversion_rate": me.frm.doc.plc_conversion_rate,
			"company": me.frm.doc.company,
			"transaction_date": me.frm.doc.transaction_date || me.frm.doc.posting_date,
			"transaction_type_name": me.frm.doc.transaction_type,
			"campaign": me.frm.doc.campaign,
			"sales_partner": me.frm.doc.sales_partner,
			"ignore_pricing_rule": me.frm.doc.ignore_pricing_rule,
			"doctype": me.frm.doc.doctype,
			"name": me.frm.doc.name,
			"is_return": cint(me.frm.doc.is_return),
			"update_stock": in_list(['Sales Invoice', 'Purchase Invoice'], me.frm.doc.doctype) ? cint(me.frm.doc.update_stock) : 0,
			"conversion_factor": me.frm.doc.conversion_factor,
			"pos_profile": me.frm.doc.doctype == 'Sales Invoice' ? me.frm.doc.pos_profile : '',
			"coupon_code": me.frm.doc.coupon_code
		};
	},

	_get_item_list: function(item) {
		var item_list = [];
		var append_item = function(d) {
			if (d.item_code) {
				item_list.push({
					"doctype": d.doctype,
					"name": d.name,
					"child_docname": d.name,
					"item_code": d.item_code,
					"item_group": d.item_group,
					"brand": d.brand,
					"qty": d.qty,
					"stock_qty": d.stock_qty,
					"uom": d.uom,
					"stock_uom": d.stock_uom,
					"parenttype": d.parenttype,
					"parent": d.parent,
					"pricing_rules": d.pricing_rules,
					"warehouse": d.warehouse,
					"serial_no": d.serial_no,
					"discount_percentage": d.discount_percentage || 0.0,
					"price_list_rate": d.price_list_rate,
					"conversion_factor": d.conversion_factor || 1.0,
					"apply_discount_after_taxes": d.apply_discount_after_taxes,
					"allow_zero_valuation_rate": d.allow_zero_valuation_rate
				});

				// if doctype is Quotation Item / Sales Order Iten then add Margin Type and rate in item_list
				if (in_list(["Quotation Item", "Sales Order Item", "Delivery Note Item", "Sales Invoice Item"]), d.doctype){
					item_list[0]["margin_type"] = d.margin_type;
					item_list[0]["margin_rate_or_amount"] = d.margin_rate_or_amount;
				}
			}
		};

		if (item) {
			append_item(item);
		} else {
			$.each(this.frm.doc["items"] || [], function(i, d) {
				append_item(d);
			});
		}
		return item_list;
	},

	_set_values_for_item_list: function(children) {
		var me = this;
		var price_list_rate_changed = false;
		var items_rule_dict = {};

		for(var i=0, l=children.length; i<l; i++) {
			var d = children[i];
			var existing_pricing_rule = frappe.model.get_value(d.doctype, d.name, "pricing_rules");
			for(var k in d) {
				var v = d[k];
				if (["doctype", "name"].indexOf(k)===-1) {
					if(k=="price_list_rate") {
						if(flt(v) != flt(d.price_list_rate)) price_list_rate_changed = true;
					}
					frappe.model.set_value(d.doctype, d.name, k, v);
				}
			}

			// if pricing rule set as blank from an existing value, apply price_list
			if(!me.frm.doc.ignore_pricing_rule && existing_pricing_rule && !d.pricing_rules) {
				me.apply_price_list(frappe.get_doc(d.doctype, d.name));
			} else if(!d.pricing_rules) {
				me.remove_pricing_rule(frappe.get_doc(d.doctype, d.name));
			}

			if (d.free_item_data) {
				me.apply_product_discount(d.free_item_data);
			}

			if (d.apply_rule_on_other_items) {
				items_rule_dict[d.name] = d;
			}
		}

		me.apply_rule_on_other_items(items_rule_dict);

		if(!price_list_rate_changed) me.calculate_taxes_and_totals();
	},

	apply_rule_on_other_items: function(args) {
		const me = this;
		const fields = ["discount_percentage", "pricing_rules", "discount_amount", "rate"];

		for(var k in args) {
			let data = args[k];

			if (data && data.apply_rule_on_other_items) {
				me.frm.doc.items.forEach(d => {
					if (in_list(JSON.parse(data.apply_rule_on_other_items), d[data.apply_rule_on])) {
						for(var k in data) {
							if (in_list(fields, k) && data[k] && (data.price_or_product_discount === 'Price' || k === 'pricing_rules')) {
								frappe.model.set_value(d.doctype, d.name, k, data[k]);
							}
						}
					}
				});
			}
		}
	},

	apply_product_discount: function(free_item_data) {
		const items = this.frm.doc.items.filter(d => (d.item_code == free_item_data.item_code
			&& d.is_free_item)) || [];

		if (!items.length) {
			let row_to_modify = frappe.model.add_child(this.frm.doc,
				this.frm.doc.doctype + ' Item', 'items');

			for (let key in free_item_data) {
				row_to_modify[key] = free_item_data[key];
			}
		} if (items && items.length && free_item_data) {
			items[0].qty = free_item_data.qty
		}
	},

	apply_price_list: function(item, reset_plc_conversion) {
		// We need to reset plc_conversion_rate sometimes because the call to
		// `erpnext.stock.get_item_details.apply_price_list` is sensitive to its value
		if (!reset_plc_conversion) {
			this.frm.set_value("plc_conversion_rate", "");
		}

		var me = this;
		var args = this._get_args(item);
		if (!args.items || !args.items.length || !args.price_list) {
			return;
		}

		if (me.in_apply_price_list == true) return;

		me.in_apply_price_list = true;
		return this.frm.call({
			method: "erpnext.stock.get_item_details.apply_price_list",
			args: {	args: args },
			callback: function(r) {
				if (!r.exc) {
					frappe.run_serially([
						() => me.frm.set_value("price_list_currency", r.message.parent.price_list_currency),
						() => me.frm.set_value("plc_conversion_rate", r.message.parent.plc_conversion_rate),
						() => {
							if(args.items.length) {
								me._set_values_for_item_list(r.message.children);
							}
						},
						() => { me.in_apply_price_list = false; }
					]);

				} else {
					me.in_apply_price_list = false;
				}
			}
		}).always(() => {
			me.in_apply_price_list = false;
		});
	},

	get_latest_price: function() {
		this.apply_price_list();
	},

	remove_pricing_rule: function(item) {
		let me = this;
		const fields = ["discount_percentage",
			"discount_amount", "margin_rate_or_amount", "rate_with_margin"];

		if(item.remove_free_item) {
			var items = [];

			me.frm.doc.items.forEach(d => {
				if(d.item_code != item.remove_free_item || !d.is_free_item) {
					items.push(d);
				}
			});

			me.frm.doc.items = items;
			refresh_field('items');
		} else if(item.applied_on_items && item.apply_on) {
			const applied_on_items = JSON.parse(item.applied_on_items);
			me.frm.doc.items.forEach(row => {
				if(in_list(applied_on_items, row[item.apply_on])) {
					fields.forEach(f => {
						row[f] = 0;
					});

					["pricing_rules", "margin_type"].forEach(field => {
						if (row[field]) {
							row[field] = '';
						}
					})
				}
			});

			me.trigger_price_list_rate();
		}
	},

	trigger_price_list_rate: function() {
		var me  = this;

		this.frm.doc.items.forEach(child_row => {
			me.frm.script_manager.trigger("price_list_rate",
				child_row.doctype, child_row.name);
		})
	},

	validate_company_and_party: function() {
		var me = this;
		var valid = true;

		$.each(["company", "customer"], function(i, fieldname) {
			if(frappe.meta.has_field(me.frm.doc.doctype, fieldname) && me.frm.doc.doctype != "Purchase Order") {
				if (!me.frm.doc[fieldname]) {
					frappe.msgprint(__("Please specify") + ": " +
						frappe.meta.get_label(me.frm.doc.doctype, fieldname, me.frm.doc.name) +
						". " + __("It is needed to fetch Item Details."));
					valid = false;
				}
			}
		});
		return valid;
	},

	get_terms: function() {
		var me = this;

		erpnext.utils.get_terms(this.frm.doc.tc_name, this.frm.doc, function(r) {
			if(!r.exc) {
				me.frm.set_value("terms", r.message);
			}
		});
	},

	taxes_and_charges: function() {
		var me = this;
		if(this.frm.doc.taxes_and_charges) {
			return this.frm.call({
				method: "erpnext.controllers.accounts_controller.get_taxes_and_charges",
				args: {
					"master_doctype": frappe.meta.get_docfield(this.frm.doc.doctype, "taxes_and_charges",
						this.frm.doc.name).options,
					"master_name": this.frm.doc.taxes_and_charges
				},
				callback: function(r) {
					if(!r.exc) {
						if(me.frm.doc.shipping_rule && me.frm.doc.taxes) {
							for (let tax of r.message) {
								me.frm.add_child("taxes", tax);
							}

							refresh_field("taxes");
						} else {
							me.frm.set_value("taxes", r.message);
							me.calculate_taxes_and_totals();
						}
					}
				}
			});
		}
	},

	tax_category: function() {
		var me = this;
		if(me.frm.updating_party_details) return;

		frappe.run_serially([
			() => this.update_item_tax_map(),
			() => erpnext.utils.set_taxes(this.frm, "tax_category"),
		]);
	},

	item_tax_template: function(doc, cdt, cdn) {
		var me = this;
		if(me.frm.updating_party_details) return;

		var item = frappe.get_doc(cdt, cdn);

		if(item.item_tax_template) {
			return this.frm.call({
				method: "erpnext.stock.get_item_details.get_item_tax_map",
				args: {
					company: me.frm.doc.company,
					item_tax_template: item.item_tax_template,
					as_json: true
				},
				callback: function(r) {
					if(!r.exc) {
						item.item_tax_rate = r.message;
						me.add_taxes_from_item_tax_template(item.item_tax_rate);
						me.calculate_taxes_and_totals();
					}
				}
			});
		} else {
			item.item_tax_rate = "{}";
			me.calculate_taxes_and_totals();
		}
	},

	update_item_tax_map: function() {
		var me = this;
		var item_codes = [];
		$.each(this.frm.doc.items || [], function(i, item) {
			if(item.item_code) {
				item_codes.push(item.item_code);
			}
		});

		if(item_codes.length) {
			return this.frm.call({
				method: "erpnext.stock.get_item_details.get_item_tax_info",
				args: {
					company: me.frm.doc.company,
					tax_category: cstr(me.frm.doc.tax_category),
					item_codes: item_codes
				},
				callback: function(r) {
					if(!r.exc) {
						$.each(me.frm.doc.items || [], function(i, item) {
							if(item.item_code && r.message.hasOwnProperty(item.item_code)) {
								if (!item.item_tax_template) {
									item.item_tax_template = r.message[item.item_code].item_tax_template;
									item.item_tax_rate = r.message[item.item_code].item_tax_rate;
								}
								me.add_taxes_from_item_tax_template(item.item_tax_rate);
							} else {
								item.item_tax_template = "";
								item.item_tax_rate = "{}";
							}
						});
						me.calculate_taxes_and_totals();
					}
				}
			});
		}
	},

	get_item_defaults_args: function () {
		var me = this;
		var items = [];

		$.each(this.frm.doc.items || [], function(i, item) {
			if(item.item_code) {
				items.push({
					name: item.name,
					item_code: item.item_code,
					cost_center: item.cost_center,
					income_account: item.income_account,
					expense_account: item.expense_account,
					apply_discount_after_taxes: item.apply_discount_after_taxes,
					allow_zero_valuation_rate: me.allow_zero_valuation_rate,
					warehouse: item.warehouse
				});
			}
		});

		return {
			args: {
				doctype: me.frm.doc.doctype,
				company: me.frm.doc.company,
				transaction_type_name: me.frm.doc.transaction_type,
				customer: me.frm.doc.customer,
				supplier: me.frm.doc.supplier,
				project: me.frm.doc.project,
				set_warehouse: me.frm.doc.set_warehouse
			},
			items: items
		};
	},

	update_item_defaults: function(set_warehouse) {
		var me = this;
		var args = me.get_item_defaults_args();
		args['set_warehouse'] = cint(set_warehouse);

		if(args.items.length) {
			return frappe.call({
				method: "erpnext.stock.get_item_details.get_item_defaults_info",
				args: args,
				callback: function(r) {
					if(!r.exc) {
						me.set_item_defaults(r.message);
					}
				}
			});
		}
	},

	set_item_defaults: function (items_dict) {
		var me = this;
		$.each(me.frm.doc.items || [], function(i, item) {
			if(item.item_code && items_dict.hasOwnProperty(item.name)) {
				frappe.model.set_value(item.doctype, item.name, items_dict[item.name]);
			}
		});
	},

	transaction_type: function() {
		var me = this;

		var args = me.get_item_defaults_args();
		args.args.letter_of_credit = me.frm.doc.letter_of_credit;
		args.args.bill_to = me.frm.doc.bill_to;

		return frappe.call({
			method: "erpnext.accounts.doctype.transaction_type.transaction_type.get_transaction_type_details",
			args: args,
			callback: function(r) {
				if(!r.exc) {
					me.set_item_defaults(r.message.items);

					$.each(r.message.doc || {}, function (k, v) {
						if (me.frm.fields_dict[k]) {
							if (k === 'cost_center') {
								me.frm.doc[k] = v;
								me.frm.refresh_field('cost_center');
							} else {
								me.frm.set_value(k, v);
							}
						}
					});

					erpnext.utils.set_taxes(me.frm, 'transaction_type');
				}
			}
		});
	},

	cost_center: function(doc, cdt, cdn) {
		if (cdt !== this.frm.doc.doctype) {
			return;
		}
		erpnext.utils.set_taxes(this.frm, 'cost_center');
	},

	has_stin: function() {
		erpnext.utils.set_taxes(this.frm, 'has_stin');
	},

	is_recurring: function() {
		// set default values for recurring documents
		if(this.frm.doc.is_recurring && this.frm.doc.__islocal) {
			frappe.msgprint(__("Please set recurring after saving"));
			this.frm.set_value('is_recurring', 0);
			return;
		}

		if(this.frm.doc.is_recurring) {
			if(!this.frm.doc.recurring_id) {
				this.frm.set_value('recurring_id', this.frm.doc.name);
			}

			var owner_email = this.frm.doc.owner=="Administrator"
				? frappe.user_info("Administrator").email
				: this.frm.doc.owner;

			this.frm.doc.notification_email_address = $.map([cstr(owner_email),
				cstr(this.frm.doc.contact_email)], function(v) { return v || null; }).join(", ");
			this.frm.doc.repeat_on_day_of_month = frappe.datetime.str_to_obj(this.frm.doc.posting_date).getDate();
		}

		refresh_many(["notification_email_address", "repeat_on_day_of_month"]);
	},

	from_date: function() {
		// set to_date
		if(this.frm.doc.from_date) {
			var recurring_type_map = {'Monthly': 1, 'Quarterly': 3, 'Half-yearly': 6,
				'Yearly': 12};

			var months = recurring_type_map[this.frm.doc.recurring_type];
			if(months) {
				var to_date = frappe.datetime.add_months(this.frm.doc.from_date,
					months);
				this.frm.doc.to_date = frappe.datetime.add_days(to_date, -1);
				refresh_field('to_date');
			}
		}
	},

	set_gross_profit: function(item) {
		if (this.frm.doc.doctype == "Sales Order" && item.valuation_rate) {
			var rate = flt(item.rate) * flt(this.frm.doc.conversion_rate || 1);
			item.gross_profit = flt(((rate - item.valuation_rate) * item.stock_qty), precision("amount", item));
		}
	},

	setup_item_selector: function() {
		// TODO: remove item selector

		return;
		// if(!this.item_selector) {
		// 	this.item_selector = new erpnext.ItemSelector({frm: this.frm});
		// }
	},

	get_advances: function() {
		var me = this;
		if(!this.frm.is_return) {
			return this.frm.call({
				method: "set_advances",
				doc: this.frm.doc,
				callback: function(r, rt) {
					refresh_field("advances");
					me.calculate_taxes_and_totals();
				}
			})
		}
	},

	make_payment_entry: function() {
		return frappe.call({
			method: cur_frm.cscript.get_method_for_payment(),
			args: {
				"dt": cur_frm.doc.doctype,
				"dn": cur_frm.doc.name
			},
			callback: function(r) {
				var doclist = frappe.model.sync(r.message);
				frappe.set_route("Form", doclist[0].doctype, doclist[0].name);
				// cur_frm.refresh_fields()
			}
		});
	},

	get_method_for_payment: function(){
		var method = "erpnext.accounts.doctype.payment_entry.payment_entry.get_payment_entry";
		if(cur_frm.doc.__onload && cur_frm.doc.__onload.make_payment_via_journal_entry){
			if(in_list(['Sales Invoice', 'Purchase Invoice'],  cur_frm.doc.doctype)){
				method = "erpnext.accounts.doctype.journal_entry.journal_entry.get_payment_entry_against_invoice";
			}else {
				method= "erpnext.accounts.doctype.journal_entry.journal_entry.get_payment_entry_against_order";
			}
		}

		return method
	},

	set_query_for_batch: function(doc, cdt, cdn) {
		// Show item's batches in the dropdown of batch no

		var me = this;
		var item = frappe.get_doc(cdt, cdn);

		if(!item.item_code) {
			frappe.throw(__("Please enter Item Code to get batch no"));
		} else if (doc.doctype == "Purchase Receipt" ||
			(doc.doctype == "Purchase Invoice" && doc.update_stock)) {

			return {
				filters: {'item': item.item_code}
			}
		} else {
			let filters = {
				'item_code': item.item_code,
				'posting_date': me.frm.doc.posting_date || frappe.datetime.nowdate(),
			}

			if (doc.is_return) {
				filters["is_return"] = 1;
			}

			if (item.warehouse) filters["warehouse"] = item.warehouse;

			return {
				query : "erpnext.controllers.queries.get_batch_no",
				filters: filters
			}
		}
	},

	payment_terms_template: function() {
		var me = this;
		const doc = this.frm.doc;
		if(doc.payment_terms_template && doc.doctype !== 'Delivery Note') {
			var posting_date = doc.posting_date || doc.transaction_date;
			frappe.call({
				method: "erpnext.controllers.accounts_controller.get_payment_terms",
				args: {
					terms_template: doc.payment_terms_template,
					posting_date: posting_date,
					delivery_date: doc.delivery_date,
					grand_total: doc.rounded_total || doc.grand_total,
					bill_date: doc.bill_date
				},
				callback: function(r) {
					if(r.message && !r.exc) {
						me.frm.set_value("payment_schedule", r.message);
					}
				}
			})
		}
	},

	payment_term: function(doc, cdt, cdn) {
		var row = locals[cdt][cdn];
		if(row.payment_term) {
			frappe.call({
				method: "erpnext.controllers.accounts_controller.get_payment_term_details",
				args: {
					term: row.payment_term,
					bill_date: this.frm.doc.bill_date,
					posting_date: this.frm.doc.posting_date || this.frm.doc.transaction_date,
					grand_total: this.frm.doc.rounded_total || this.frm.doc.grand_total
				},
				callback: function(r) {
					if(r.message && !r.exc) {
						for (var d in r.message) {
							frappe.model.set_value(cdt, cdn, d, r.message[d]);
						}
					}
				}
			})
		}
	},

	blanket_order: function(doc, cdt, cdn) {
		var me = this;
		var item = locals[cdt][cdn];
		if (item.blanket_order && (item.parenttype=="Sales Order" || item.parenttype=="Purchase Order")) {
			frappe.call({
				method: "erpnext.stock.get_item_details.get_blanket_order_details",
				args: {
					args:{
						item_code: item.item_code,
						customer: doc.customer,
						supplier: doc.supplier,
						company: doc.company,
						transaction_date: doc.transaction_date,
						blanket_order: item.blanket_order
					}
				},
				callback: function(r) {
					if (!r.message) {
						frappe.throw(__("Invalid Blanket Order for the selected Customer and Item"));
					} else {
						frappe.run_serially([
							() => frappe.model.set_value(cdt, cdn, "blanket_order_rate", r.message.blanket_order_rate),
							() => me.frm.script_manager.trigger("price_list_rate", cdt, cdn)
						]);
					}
				}
			})
		}
	},

	set_reserve_warehouse: function() {
		this.autofill_warehouse(this.frm.doc.supplied_items, "reserve_warehouse", this.frm.doc.set_reserve_warehouse);
	},

	set_warehouse: function() {
		this.autofill_warehouse(this.frm.doc.items, "warehouse", this.frm.doc.set_warehouse);
	},

	autofill_warehouse : function (child_table, warehouse_field, warehouse, force) {
		if ((warehouse || force) && child_table && child_table.length) {
			let doctype = child_table[0].doctype;
			$.each(child_table || [], function(i, item) {
				if (force || !item.force_default_warehouse || warehouse_field != "warehouse") {
					frappe.model.set_value(doctype, item.name, warehouse_field, warehouse);
				}
			});
		}
	},

	coupon_code: function() {
		var me = this;
		frappe.run_serially([
			() => this.frm.doc.ignore_pricing_rule=1,
			() => me.ignore_pricing_rule(),
			() => this.frm.doc.ignore_pricing_rule=0,
			() => me.apply_pricing_rule()
		]);
	},

	add_get_latest_price_button: function () {
		var me = this;
		me.frm.add_custom_button(__("Get Latest Prices"), function() {
			me.get_latest_price();
		}, __("Prices"));
	},

	add_update_price_list_button: function () {
		var me = this;
		me.frm.add_custom_button(__("Update Price List"), function() {
			me.update_item_prices();
		}, __("Prices"));
	},
});

erpnext.show_serial_batch_selector = function(frm, d, callback, on_close, show_dialog, on_make_dialog) {
	frappe.require("assets/erpnext/js/utils/serial_no_batch_selector.js", function() {
		new erpnext.SerialNoBatchSelector({
			frm: frm,
			item: d,
			warehouse_details: {
				type: "Warehouse",
				name: d.warehouse
			},
			callback: callback,
			on_close: on_close,
			on_make_dialog: on_make_dialog
		}, show_dialog);
	});
}
