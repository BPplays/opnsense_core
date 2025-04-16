/*
 * Copyright (C) 2025 Deciso B.V.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *    this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED ``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES,
 * INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
 * AUTHOR BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY,
 * OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

$.fn.bootgrid = function(option, ...args) {
    let ret;

    this.each(function() {
        const $el = $(this);
        let instance = $el.data('UIBootgrid');

        if (typeof option === 'object' || option === undefined) {
            // Caller instantiated jQuery bootgrid directly, unsupported
            return;
        }

        if (typeof option === 'string' && instance && typeof instance[option] === 'function') {
            // pass legacy bootgrid calls to new UIBootgrid implementation
            ret = instance[option](...args);
            return false;
        }
    });

    return ret !== undefined ? ret : this;
}

$.fn.UIBootgrid = function(params) {
    let id = this.attr('id');
    const $original = this;
    // while we have the element, figure out if we're in a responsive container before removing it
    // this determines whether rows should break to a newline or overflow (ellipsis)
    let responsive = this.parents('.table-responsive').length > 0;
    if (params?.options?.responsive ?? false) {
        responsive = params.options.responsive;
    }
    (params.options ??= {}).responsive = responsive;
    const $clone = $original.clone(true, true);
    const $replacement = $('<div>').attr('id', id);
    $original.replaceWith($replacement);

    let bg = new UIBootgrid(id).translateCompatOptions(params, $clone).initialize();

    // store the instance so calls to $.bootgrid(...) are wired to the new implementation
    $replacement.data('UIBootgrid', bg);

    return $replacement;
}

class UIBootgrid {
    constructor(id, options = {}, crud = {}, tabulatorOptions = {}, translations = {}) {
        // wrapper-specific state variables
        this.id = id;
        this.$element = $(`#${id}`);
        this.table = null;
        this.searchPhrase = "";
        this.searchTimer = null;
        this.curRowCount = null;
        this.navigationRendered = false;
        this.originalTableHeight = null;
        this.tableInitialized = false;
        this.isResizing = false;

        // wrapper-specific options
        this.options = {
            sorting: true,
            selection: true,
            rowCount: [7, 14, 20, 50, 100, true],
            remoteGridView: false, // parse gridview from <thead> or via ajax?
            formatters: {
                ...this._internalFormatters()
            }, // formatter callback functions passed to column definitions
            headerFormatters: {},
            sorters: {
                ...this._internalSorters()
            },
            requestHandler: (request) => request,
            responseHandler: (response) => response,
            datakey: 'uuid',
            resetButton: true,
            searchSettings: {
                delay: 1000
            },
            navigation: true,
            ajax: true,
            ajaxConfig: {
                method: "POST",
                dataType: "json",
                headers: {
                    "Content-type": 'application/json;charset=utf8',
                }
            },
            responsive: false,
            onBeforeRenderDialog: null,
            addButton: false,
            deleteSelectedButton: false,
            commands: {}, //additional registered commands
            virtualDOM: false,
            stickySelect: false,
            triggerEditFor: null,
            ...options
        };

        this.crud = crud

        // compatibility options mapped to tabulator options through translateCompatOptions()
        this.compatOptions = {};
        this.$compatElement = null;

        // passed directly to tabulator
        this.tabulatorOptions = tabulatorOptions;

        this.translations = {
            add: 'Add',
            deleteSelected: 'Delete selected',
            edit: 'Edit',
            disable: 'Disabled',
            enable: 'Enable',
            delete: 'Delete',
            info: 'Info',
            clone: 'Clone',
            all: 'All',
            search: 'Search',
            removeWarning: 'Remove selected item(s)?',
            noresultsfound: 'No results found!',
            ...translations
        };

        // wrapper-specific single version of truth of table layout
        this.gridView = null;
    }

    initialize() {
        if (this.options.triggerEditFor) {
            this.command_edit(null, this.options.triggerEditFor);
        }

        this._parseGridView();
        this._constructTable();
        this._registerEvents();
        this._renderActionBar();

        return this;
    }

    /**
    * convert old-style UIBootgrid (and jQuery bootgrid) options.
    * The original defaults are already mapped to defaults in tabulatorDefaults()
    * 
    * This function modifies this.compatOptions if options can be directly included in Tabulator.
    * Otherwise, this.options is modified for wrapper-specific implementations (i.e. rowCount, requestHandler).
    */
    translateCompatOptions(compatOptions, $table) {
        this.$compatElement = $table;

        let bootGridOptions = compatOptions.options;

        if (!(bootGridOptions?.ajax ?? true)) {
            this.options.ajax = false;
            // unset all remote facilities
            this.compatOptions['sortMode'] = 'local';
            this.compatOptions['paginationMode'] = 'local';
            this.compatOptions['filterMode'] = 'local';
        }

        if (!(bootGridOptions?.selection ?? true)) {
            this.compatOptions['selectableRows'] = false;
            this.compatOptions['rowHeader'] = null;
        } else if (!(bootGridOptions?.multiSelect ?? true)) {
            this.compatOptions['selectableRows'] = 1;
        }

        if (bootGridOptions?.stickySelect ?? false) {
            this.options.stickySelect = true;
        }

        if (bootGridOptions?.triggerEditFor ?? null) {
            this.options.triggerEditFor = bootGridOptions.triggerEditFor;
        }

        // navigation, determines whether actionbar, pagination and footer is rendered
        if ((bootGridOptions?.navigation ?? 3) === 0) {
            this.options.navigation = false;
        }

        if (bootGridOptions?.rowCount ?? false) {
            // -1 signified "all" previously. rowCount and paginationSize are handled in this wrapper
            this.options.rowCount = bootGridOptions.rowCount.map(item => item === -1 ? true : item);
        }

        // we assume a url is unconditional
        this.compatOptions['ajaxURL'] = compatOptions?.search;

        if (bootGridOptions?.initialSearchPhrase ?? false) {
            this.searchPhrase = bootGridOptions.initialSearchPhrase;
        }

        if (bootGridOptions?.ajaxSettings ?? false) {
            if (bootGridOptions.ajaxSettings?.contentType) {
                this.options.ajaxConfig.headers['Content-type'] = bootGridOptions.ajaxSettings.contentType;
            }

            if (bootGridOptions.ajaxSettings?.dataType) {
                this.options.ajaxConfig.dataType = bootGridOptions.ajaxSettings.dataType
            }
        }

        if (bootGridOptions?.requestHandler ?? false) {
            this.options.requestHandler = bootGridOptions.requestHandler;
        }

        if (bootGridOptions?.responseHandler ?? false) {
            this.options.responseHandler = bootGridOptions.responseHandler;
        }

        if (bootGridOptions?.searchSettings ?? false) {
            if (bootGridOptions.searchSettings?.delay) {
                this.options.searchSettings.delay = bootGridOptions.searchSettings.delay;
            }
        }

        if (bootGridOptions?.datakey) {
            this.options.datakey = bootGridOptions.datakey;
        }

        if (bootGridOptions?.onBeforeRenderDialog) {
            this.options.onBeforeRenderDialog = bootGridOptions.onBeforeRenderDialog;
        }

        if (!(bootGridOptions?.sorting ?? true)) {
            this.options.sorting = false;
        }

        if (compatOptions.get) this.crud.get = compatOptions.get;
        if (compatOptions.set) this.crud.set = compatOptions.set;
        if (compatOptions.add) this.crud.add = compatOptions.add;
        if (compatOptions.del) this.crud.del = compatOptions.del;
        if (compatOptions.info) this.crud.info = compatOptions.info;
        if (compatOptions.toggle) this.crud.toggle = compatOptions.toggle;

        // any additional commands?
        if ('commands' in compatOptions) {
            this.options.commands = compatOptions.commands;
        }

        // check if add / delete buttons are present
        let add = this.$compatElement.find("*[data-action=add]");
        let del = this.$compatElement.find("*[data-action=deleteSelected]");

        if (add.length > 0) {
            this.options.addButton = true;
        }

        if (del.length > 0) {
            this.options.deleteSelectedButton = true;
        }

        // convert old-style formatters
        for (const [key, formatterFn] of Object.entries(bootGridOptions?.formatters ?? {})) {
            this.options.formatters[key] = (cell, formatterParams, onRendered) => {
                let def = cell.getColumn().getDefinition();
                let column = {
                    id: def.field,
                    visible: def.visible
                };
                return formatterFn(column, cell.getData());
            }
        }

        // convert header formatters
        for (const [key, formatterFn] of Object.entries(bootGridOptions?.headerFormatters ?? {})) {
            this.options.headerFormatters[key] = (cell, formatterParams, onRendered) => {
                let def = cell.getColumn().getDefinition();
                let column = {
                    id: def.field,
                    visible: def.visible
                };
                return formatterFn(column);
            }
        }

        // convert old-style converters
        // For context: these converters are relevant to have a notion of sorting or localization for column values
        // in cases where the backend doesn't do sorting for us (ajax=false).
        // The only relevant ones seem to be "datetime", "memsize", "string", "numeric".
        // however, there are some overridden ones (IDS, voucher). For these it should be investigated
        // whether these require a formatter instead (IDS ajax=true while voucher ajax=false),
        // "from" function represents loading a retrieved value (from backend) into the table system in a sortable format
        // "to" function represents converting the "from'ed" internal value back to something human-readable (often what the backend returned).
        // in all cases where ajax=true, we need to think twice whether we need the converter and should
        // apply a formatter instead (data-type="datetime" for ca.volt for example)
        if (this.options.ajax && 'converters' in bootGridOptions) {
            for (const [key, converter] of Object.entries(bootGridOptions.converters)) {
                console.error(`Converter "${key}" should be a formatter`);
            }
        }


        // Detect if old bootgrid was of 'responsive' type, meaning:
        // - overflow: inherit !important
        // - white-space : inherit !important
        //
        // which allows for newlines in the table (such as log files)
        // 
        // otherwise:
        // - text-overflow: ellipsis;
        // - white-space: nowrap
        // - overflow: hidden

        this.options.responsive = bootGridOptions?.responsive ?? false;

        // We set the virtualDOM rendering mode off by default,
        // but if there are pages where we expect this will speed up rendering a lot,
        // those pages can set 'virtualDOM: true' to force this (i.e. log pages).
        // These pages must implement any event handlers for cells
        // in the formatter, not on the "loaded" event. If such elements include the 'bootgrid-tooltip' class,
        // tooltips will automatically be activated when dynamically inserted into the DOM.
        this.options.virtualDOM = bootGridOptions?.virtualDOM ?? false;
        if (this.options.virtualDOM) {
            this.compatOptions['renderVertical'] = 'virtual';
        }

        return this;
    }

    normalizeRowHeight() {
        this.table.getRows().forEach(row => {
            row.normalizeHeight();
        });
        this._syncTableHeight();
    }

    _parseGridView() {
        let result = {};
        if (this.options.remoteGridView) {
            throw new Error('fetching remote grid view not yet implemented');
        } else {
            if (!this.$compatElement) {
                throw new Error('unable to parse table headers, no table element provided');
            }

            let firstHeadRow = this.$compatElement.find("thead > tr").first();

            // insert the old table structure offscreen so the "em" values can be extracted
            // Tabulator does not support using em units, so convert them to pixel values
            // XXX move this step to the UIBootgrid jQuery initializer
            this.$compatElement.css({position: 'absolute',visibility: 'hidden'}).appendTo('.content-box-main .col-sm-12');

            firstHeadRow.children().each((i, row) => {
                let $row = $(row);
                let data = $row.data();

                if (data.visible == false) {
                    $row.hide();
                }

                let parseEmWidth = (value) => {
                    if (typeof value !== "string" || !value.endsWith('em')) {
                        return null;
                    }

                    $row.width(value);
                    // XXX this isn't entirely accurate, but it's close enough to the old situation
                    return parseFloat($row.outerWidth());
                };

                if (data.type && this.options.ajax && data.type in this.options.formatters) {
                    // use formatters instead of converters
                    data.formatter = data.type;
                }

                result[data.columnId] = {
                    id: data.columnId,
                    label: $row.text(),
                    style: data.cssClass ?? '',
                    type: data.type ?? 'text',
                    formatter: data.formatter ?? null,
                    headerFormatter: data.headerFormatter || 
                                    !(Object.getOwnPropertyNames(Object.prototype).includes(data.columnId)) &&
                                    data.columnId in this.options.headerFormatters ?
                                    data.columnId : null,
                    visible: data.visible ?? true,
                    sequence: data.sequence ?? null,
                    width: isNaN(data.width) ? parseEmWidth(data.width) : data.width,
                    editable: false,
                }
            })

            this.$compatElement.remove();
        }

        this.gridView = result;
    }

    /**
     * 
     * @returns array of column objects in tabulator-format based on this.gridView and this.options
     */
    _parseColumns() {
        let result = [];

        for (const [key, field] of Object.entries(this.gridView)) {
            let col = {};
            if (field.id === 'commands') {
                col = {
                    visible: field.visible,
                    formatter: this.options.formatters['commands'] ?? null,
                    title: field.label,
                    resizable: false,
                    sequence: field.sequence ?? null,
                    frozen: true,
                    headerSort: false,
                    headerHozAlign: "center",
                    hozAlign:  'center',
                }
            } else {
                col = { 
                    visible: field.visible,
                    editable: field.editable,
                    // XXX passes unsanitized HTML, which may be of concern if the cell is editable in the future
                    formatter: this.options.formatters[field?.formatter] ?? this.options.formatters['default'],
                    title: field.label,
                    titleFormatter: this.options.headerFormatters[field?.headerFormatter] ?? null,
                    field: field.id,
                    resizable: true,
                    sequence: field.sequence ?? null,
                    headerSort: this.options.sorting,
                    cssClass: this.options.responsive ? 'opnsense-bootgrid-responsive' : '',
                    variableHeight: true,
                    sorter: this.options.sorters[field.type] ?? null,
                }
            }

            if (field.width && !col.resizable) {
                // lock the width in place
                col['minWidth'] = field.width;
                col['maxWidth'] = field.width;
            } else if (field.width) {
                col['width'] = field.width;
            }

            result.push(col);
        }

        result.sort((a, b) => {
            if (a.sequence == null && b.sequence == null) return 0;
            if (a.sequence == null) return 1;
            if (b.sequence == null) return -1;
            return a.sequence - b.sequence;
        });

        result.forEach(item => delete item.sequence);

        return result;
    }

    _constructTable() {
        this.table = new Tabulator(`#${this.id}`, {
            ...this.tabulatorDefaults(),

            /* compatibility options */
            ...this.compatOptions,

            /* custom passed options */
            ...this.tabulatorOptions
        });
    }

    _destroyTable() {
        this.table.destroy();
    }

    _registerEvents() {
        this.table.on('dataLoading', () => {
            if (!this.navigationRendered) {
                this._renderFooter();
                this._populateColumnSelection();
                this.navigationRendered = true;
            }
        });

        this.table.on('tableBuilt', () => {
            if (this.options.virtualDOM) {
                // Start watching for dynamically inserted DOM elements and trigger their tooltips.
                // XXX This has a slight performance penalty on virtual DOM scrolling for large datasets.
                let targetNode = $(`#${this.id} .tabulator-table`)[0];
                var observer = new MutationObserver((mutationsList, observer) => {
                    mutationsList.forEach((mutation) => {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType === 1 && $(node).hasClass('tabulator-row')) {
                            let commands = $(node).find('.bootgrid-tooltip');
                            if (commands.length > 0) {
                                this._tooltips();
                            }
                        }
                    }); 
                    });
                });
                
                observer.observe(targetNode, {
                    childList: true,
                    subtree: false
                });
            }

            if (!this.options.ajax) {
                this.table.setPageSize(this.curRowCount);

                this.table.on("pageLoaded", (pageno) => {
                    this._onDataProcessed();
                })
            }

            // make sure we redraw the table as it enters the viewport (multiple tabbed grids)
            // since tabulator needs the page dimensions
            const intersectObserver = new IntersectionObserver((entries, observer) => {
                entries.forEach(entry => {
                  if (entry.isIntersecting) {
                    this.table.redraw(true);
                    this._onDataProcessed();
                  }
                });
            });

            intersectObserver.observe(this.$element[0]);

            this._handleColumnResizing();

            this.tableInitialized = true;
        });

        this.table.on('dataProcessed', () =>  {
            this._onDataProcessed();
        });

        this.table.on('dataChanged', this._debounce(() => {
            // debounce this so we catch the correct event if
            // data has been added (this event fires in rapid succession in this case,
            // but doesn't trigger dataProcessed at the end)
            this._onDataProcessed();
        }));

        this.table.on('cellMouseEnter', (e, cell) => {
            // tooltip when ellipsis is used (overflow on text elements without children)
            let el = cell.getElement();
            let $el = $(el);
            if (el.offsetWidth < el.scrollWidth && !$el.attr('title') && $el.children().length == 0){
                $el.attr('title', $el.text()).tooltip({container: 'body', trigger: 'hover'}).tooltip('show');
            }
        });

        this.table.on('rowSelected', (row) => {
            this.$element.trigger("selected.rs.jquery.bootgrid", [this.table.getSelectedData()]);
        });

        this.table.on('rowDeselected', (row) => {
            this.$element.trigger("deselected.rs.jquery.bootgrid", [[row.getData()]]);
        });

        this.table.on("rowSelectionChanged", this._debounce((data, rows, selected, deselected) => {
            // XXX debouncing this is a bit of a hack, but this function is run
            // for both the selection & deselection, while we only want to know
            // the last known action.
            if (this.options.stickySelect && data.length == 0) {
                this.table.selectRow(deselected[0].getData()[this.options.datakey]);
            }
        }));
    }

    _handleColumnResizing() {
        // custom resize guide for column resizing
        const $resizeGuide = $('<span class="tabulator-col-resize-guide" style="display: none;"></span>');
        this.$element.append($resizeGuide);
        const elementOffset = this.$element.offset().left;

        this.$element.on('mouseenter', '.tabulator-col-resize-handle', (e) => {
            const handleOffset = $(e.currentTarget)[0].getBoundingClientRect().left;
            const left = handleOffset - elementOffset;

            $resizeGuide.css({
                display: 'block',
                left: left + 'px',
            });
        });

        this.$element.on('mouseleave', '.tabulator-col-resize-handle', (e) => {
            $resizeGuide.hide();
        });
    }

    _renderFooter() {
        if (!this.options.navigation) {
            $('.tabulator-footer').remove();
            return;
        }

        this._renderFooterCommands();

        // swap page counter and paginator around (old look & feel).
        // we hook in before tableBuilt, but after dataLoading
        // since we know the footer is rendered at this point,
        // but we don't want to wait on the data before swapping
        // the UI elements around.

        // XXX this doesn't work on the captive portal page. why?
        let a = $(`#${this.id} .tabulator-page-counter`)[0];
        let b = $(`#${this.id} .tabulator-paginator`)[0];
        var aparent = a.parentNode;
        var asibling = a.nextSibling === b ? a : a.nextSibling;
        b.parentNode.insertBefore(a, b);
        aparent.insertBefore(b, asibling);

        // replace pagination text
        $(`#${this.id} .tabulator-paginator button[data-page=first]`).html("&laquo;");
        $(`#${this.id} .tabulator-paginator button[data-page=prev]`).html("&lsaquo;");
        $(`#${this.id} .tabulator-paginator button[data-page=next]`).html("&rsaquo;");
        $(`#${this.id} .tabulator-paginator button[data-page=last]`).html("&raquo;");
    }

    _onDataProcessed() {
        this._syncTableHeight();

        // refresh tooltips
        if (!this.options.virtualDOM) {
            this._tooltips();
        }

        this.normalizeRowHeight();

        if (this.options.virtualDOM) {
            // redraw here to prevent pagination switches from breaking the virtualdom rendering process
            this.table.redraw();
        }
        
        // DOM layout changed, rewire commands
        const commands = this._getCommands();
        Object.keys(commands).map((k) => {
            let has_option = true;
            for (let i = 0; i < commands[k]['requires'].length; i++) {
                if (!(commands[k]['requires'][i] in this.crud)) {
                    has_option = false;
                }
            }
            if (has_option) {
                this.$element.find(".command-" + k).unbind('click').on("click", commands[k].method);
            } else if ($(".command-" + k).length > 0) {
                console.log("not all requirements met to link " + k);
            }
        });

        // backwards compat
        this.$element.trigger("loaded.rs.jquery.bootgrid");
    }

    /**
     * Adjust table height based on current rowCount selection or rowheight changes to prevent dead space
     * (workaround for https://github.com/olifolkerd/tabulator/issues/4419: maxHeight does not work without a fixed height)
     */
    _syncTableHeight() {
        const tabulator = this.table;
        const table = tabulator.element;
        const rowsContainer = table.querySelector( '.tabulator-tableholder' );

        if (!rowsContainer) {
            return;
        }

        const rowsContainerHeight = parseFloat(getComputedStyle(rowsContainer).height);
        const rowsHeight = parseFloat(getComputedStyle(table.querySelector('.tabulator-table')).height);
        const diff = Math.ceil(rowsContainerHeight - rowsHeight);
        const curTotalTableHeight = parseInt(getComputedStyle(table).height);

        let overflow = rowsContainer.scrollHeight > rowsContainer.clientHeight;


        if (!this.originalTableHeight) {
            this.originalTableHeight = parseInt(this.table.options.height) * window.innerHeight / 100;

            if (diff > 0 && !overflow) {
                tabulator.setHeight(curTotalTableHeight - diff);
                this.table.redraw(true);
            }
        }


        if (diff > 0 && !overflow && !(this.lastchange === Math.abs(diff))) {
            // dead space on page load, adjust it.
            table.style.height = (curTotalTableHeight - diff) + 'px';
            this.table.redraw(true);
        } else if ((diff < 0) && overflow) {
            // scrollbar

            if ((curTotalTableHeight + Math.abs(diff)) < this.originalTableHeight) {
                // not yet max height so prevent scrollbar and grow
                table.style.height = (curTotalTableHeight + Math.abs(diff) + 'px');
                this.lastchange = Math.abs(diff);
            } else {
                table.style.height = this.originalTableHeight + 'px';
                this.table.redraw(true);
            }
        }
    }

    _tooltips() {
        this.$element.find(".bootgrid-tooltip").each((index, el) => {
            if ($(el).attr('title') !== undefined) {
                // keep this tooltip
            } else if ($(el).hasClass('command-add')) {
                $(el).attr('title', this.translations.add);
            } else if ($(el).hasClass('command-delete-selected')) {
                $(el).attr('title', this.translations.deleteSelected);
            } else if ($(el).hasClass('command-edit')) {
                $(el).attr('title', this.translations.edit);
            } else if ($(el).hasClass('command-toggle')) {
                if ($(el).data('value') === 1) {
                    $(el).attr('title', this.translations.disable);
                } else {
                    $(el).attr('title', this.translations.enable);
                }
            } else if ($(el).hasClass('command-delete')) { 
                $(el).attr('title', this.translations.delete);
            } else if ($(el).hasClass('command-info')) {
                $(el).attr('title', this.translations.info);
            } else if ($(el).hasClass('command-copy')) {
                $(el).attr('title', this.translations.clone);
            } else {
                $(el).attr('title', 'Error: no tooltip match');
            }
            $(el).tooltip({container: 'body', trigger: 'hover'});
        });
    }

    _renderActionBar() {
        if (!this.options.navigation) {
            return;
        }

        this.$element.before($(this._getHeader()));

        // search functionality
        $(`#${this.id}-search-field`).val(this.searchPhrase).on("keyup", (e) => {
            e.stopPropagation();
            let searchVal = $(`#${this.id}-search-field`).val();
            if (this.searchPhrase !== searchVal || (e.which === 13 && searchVal !== "")) {
                this.searchPhrase = searchVal;
                if (e.which === 13 || searchVal.length === 0 || searchVal.length >= 1) {
                    if (this.options.ajax) {
                        window.clearTimeout(this.searchTimer);
                        this.searchTimer = window.setTimeout(() => {
                            this._reload();
                            //this.table.setFilter('searchPhrase', '=', searchVal);
                        }, this.options.searchSettings.delay);
                    } else {
                        this.table.setFilter((data, filterParams) => {
                            return Object.values(data).some(
                                val => typeof val === 'string' && val.toLowerCase().includes(this.searchPhrase.toLowerCase())
                            )
                        });
                        this._syncTableHeight();
                    }
                }
            } else if (searchVal === "" && !this.options.ajax) {
                this.table.clearFilter();
                this._syncTableHeight();
            }
        });

        // Refresh
        if (this.options.ajax) {
            $(`#${this.id}-refresh-button`).click(() => {
                // XXX This refreshes the data, but doesn't trigger a loading screen
                this._reload();
            });
        } else {
            $(`#${this.id}-refresh-button`).remove();
        }

        // Rowcount
        this.curRowCount = localStorage.getItem(`tabulator-${this.table.options.persistenceID}-rowCount`) || this.options.rowCount[0];
        if (this.curRowCount === 'true') {
            this.curRowCount = true;
        }
        $(`#${this.id}-rowcount-text`).text(this.curRowCount === true ? this.translations.all : this.curRowCount);

        this.options.rowCount.forEach((count) => {
            let item = $(`
                <li data-action="${count}"
                    class="${count.toString() === this.curRowCount.toString() ? 'active' : ''}"
                    aria-selected="${count.toString() === this.curRowCount.toString() ? 'true' : 'false'}">
                    <a>${count === true ? this.translations.all : count}</a>
                </li>
            `).on('click', (e) => {
                e.preventDefault();

                let target = $(e.currentTarget);
                let newRowCount = target.data('action');

                if (newRowCount !== this.curRowCount) {
                    this.curRowCount = newRowCount;
                    if (!this.options.ajax) {
                        this.table.curRowCount = this.curRowCount;
                    }
                    localStorage.setItem(`tabulator-${this.table.options.persistenceID}-rowCount`, this.curRowCount);
                    this.table.setPageSize(newRowCount);

                    this._syncTableHeight();
                    $(`#${this.id}-rowcount-text`).text(newRowCount === true ? this.translations.all : newRowCount);

                    $.each($(`#${this.id}-rowcount-items li`), (i, value) => {
                        let $li = $(value);
                        let thisRowCount = $li.data('action');
                        thisRowCount.toString() === this.curRowCount.toString() ?
                            $li.addClass("active") && $li.attr('aria-selected', 'true') :
                            $li.removeClass("active") && $li.attr('aria-selected', 'false')
                    });
                }

            });
            $(`#${this.id}-rowcount-items`).append(item);
        });

        // Column selection handled after data load (see registerEvents)

        // Reset button
        if (this.options.resetButton) {
            let $resetBtn = $(`
                <button id="${this.id}-reset" class="btn btn-default" type="button" title="Reset to defaults">
                    <span class="icon fa-solid fa-share-square"></span>
                </button>
            `).on('click', (e) => {
                e.stopPropagation();
                Object.keys(localStorage)
                    .filter(key => key.startsWith(`tabulator-${this.table.options.persistenceID}`))
                    .forEach(key => localStorage.removeItem(key));
                location.reload();
            });

            $(`#${this.id}-actions-group`).append($resetBtn);
        }
    }

    _renderFooterCommands() {
        if (!this.options.navigation) {
            return;
        }

        let $footer = $(`#${this.id} > .tabulator-footer > .tabulator-footer-contents > .tabulator-paginator`);
        let $commandContainer = $('<div class="text-left bootgrid-footer-commands">');
        if (this.options.addButton) {
            $commandContainer.append($(`
                <button data-action="add" type="button" class="btn btn-xs btn-primary command-add bootgrid-tooltip">
                    <span class="fa fa-plus fa-fw"></span>
                </button>
            `));
        }

        if (this.options.deleteSelectedButton) {
            $commandContainer.append($(`
                <button data-action="deleteSelected" type="button" class="btn btn-xs btn-default command-delete-selected bootgrid-tooltip">
                    <span class="fa fa-trash-o fa-fw"></span>
                </button>
            `))

        }

        $footer.after($commandContainer);
    }

    _populateColumnSelection() {
        let columns = this.table.getColumns();
        for (let column of columns) {
            let definition = column.getDefinition();

            if (definition?.formatter === "rowSelection") {
                continue;
            }

            let item = $(`
                <li>
                    <label class="dropdown-item">
                        <input class="dropdown-item-checkbox" id="${this.id}-columnselect-input" name="${definition.field}" type="checkbox" value="1" ${column.isVisible() ? 'checked="checked"' : ''}/>
                        ${definition.title || definition.field || "&nbsp;"}  
                    </label>
                </li>
            `).on('change', (e) => {
                e.stopPropagation();
                let $target = $(e.currentTarget);
                let $checkbox = $target.find('input');
                // keep open on label click
                $(`#${this.id}-columnselect-container`).addClass('open');

                column.toggle();

                // make sure to redraw the table so new column widths are calculated
                 this.table.redraw(true);
            })

            $(`#${this.id}-columnselect-items`).append(item);
        }
    }

    /**
    * backwards compatible UIBootgrid actionbar
    */
    _getHeader() {
        return `
            <div id="${this.id}-header" class="bootgrid-header container-fluid">
                <div class="row">
                    <div class="col-sm-12 actionBar">
                        <div class="search form-group">
                            <div class="input-group">
                                <span class="icon fa-solid input-group-addon fa-magnifying-glass"></span>
                                <input id="${this.id}-search-field" type="text" class="search-field form-control" placeholder="${this.translations.search}">
                            </div>
                        </div>
                        <div id="${this.id}-actions-group" class="actions btn-group">
                            <button id="${this.id}-refresh-button" class="btn btn-default" type="button" title="Refresh">
                                <span class="icon fa-solid fa-arrows-rotate"></span>
                            </button>
                            <div id="${this.id}-rowcount-container" class="dropdown btn-group">
                                <button id="${this.id}-rowcount-button" class="btn btn-default dropdown-toggle" type="button" data-toggle="dropdown" aria-expanded="false">
                                    <span id="${this.id}-rowcount-text" class="dropdown-text"></span>
                                    <span class="caret"></span>
                                </button>
                                <ul id="${this.id}-rowcount-items" class="dropdown-menu pull-right" role="menu"></ul>
                            </div>
                            <div id="${this.id}-columnselect-container" class="dropdown btn-group">
                                <button id="${this.id}-columnselect-button" class="btn btn-default dropdown-toggle" type="button" data-toggle="dropdown" aria-expanded="false">
                                    <span class="dropdown-text"><span class="icon fa-solid fa-list"></span></span>
                                    <span class="caret"></span>
                                </button>
                                <ul id="${this.id}-columnselect-items" class="dropdown-menu pull-right" role="menu"></ul>                                 
                            </div>
                        </div>
                    </div>
                </div>    
            </div>
        `
    }

    tabulatorDefaults() {
        return {
            index: this.options.datakey,
            renderVertical:"basic", // "virtual"
            persistence:{
                sort: true, //persist column sorting
                filter: false, //persist filters
                headerFilter: true, //persist header filters
                group: true, //persist row grouping
                page: false, //persist page
                // persist columns, except for width, as this will prevent columns from scaling properly
                // after initial page load
                columns: ['visible', 'frozen']
            },
            movableColumns: true,
            persistenceID:`${window.location.pathname}#${this.id}`,
            selectableRows: true,
            selectableRowsPersistence: false,
            rowHeader: { // implements row selection checkbox
                formatter:"rowSelection",
                width: "20",
                titleFormatter: "rowSelection",
                headerSort: false,
                resizable: false,
                frozen: true,
                headerHozAlign: "center",
                hozAlign: "center",
            },
            rowFormatter: (row) => {
                // mute a row if said row is disabled (enabled=false or disabled=true)
                let data = row.getData();

                if (('disabled' in data && data.disabled == "1") || ('enabled' in data && data.enabled == "0")) {
                    $(row.getElement()).addClass('text-muted');
                }
            },
            height: '60vh',
            resizable: "header",
            placeholder: this.translations.noresultsfound, // XXX: improve styling, can return a function returning HTML or a DOM node
            layout: 'fitColumns',
            columns: this._parseColumns(),

            /* SERVER-SIDE OPTIONS */
            dataLoaderLoading: '<i class="fa fa-spinner fa-spin"></i>', // TODO improve loader screen via css

            /* pagination */
            pagination: true,
            paginationOutOfRange: function(curPage, maxPage) {
                return 'first';
            },
            paginationCounter: (pageSize, currentRow, currentPage, totalRows, totalPages) => {
                let end, start;

                if (this.options.ajax) {
                    pageSize = this.table.curRowCount === true ? this.table.paginationTotal : this.table.curRowCount;
                    totalRows = this.table.paginationTotal;
                }

                end = currentPage * pageSize;
                start = (totalRows === 0) ? 0 : ((currentPage - 1) * pageSize) + 1;
                end = (totalRows === 0 || end === -1 || end > totalRows) ? totalRows : end;

                if (this.table.totalKnown || !this.options.ajax) {
                    return `Showing ${start} to ${end} of ${totalRows} entries`
                } else {
                    return `Showing ${start} to ${end}`;
                }
            },
            paginationMode: "remote",
            dataSendParams: { // map tabulator keywords to our backend
                'page': 'current',
                'size': 'rowCount',
                'sorters': 'sort',
            },
            dataReceiveParams: { // map tabulator keywords to our backend
                'data': 'rows'
            },
            ajaxResponse: (url, params, response) => {
                // handle pagination response, set last_page as appropriate
                // the counter text (showing x of y) is handled in a module extension called "rowpage"
                if (response.total_rows != undefined) {
                    // we don't know the 'last_page'
                    // XXX we may consider removing the "go to first" and "go to last" buttons here
                    if (response.rowCount == params.rowCount) {
                        response['last_page'] = response.current + 1;
                    } else {
                        // we've stumbled on the last page
                        response['last_page'] = response.current;
                    }
                    this.table.paginationTotal = response.total_rows;
                    this.table.totalKnown = false;
                } else {
                    // total is known
                    let last_page = params.rowCount < 0 ? 1 : Math.ceil(response.total / params.rowCount);
                    response['last_page'] = last_page;
                    this.table.paginationTotal = response.total;
                    this.table.totalKnown = true;
                }
                this.table.curRowCount = this.curRowCount;

                return response;
            },

            /* server-side filtering/search logic */
            filterMode: "remote",
            ajaxRequestFunc: (url, config, params) => {
                // params.filter is an array of filter objects:
                // [
                //     {field:"age", type:">", value:52}, //filter by age greater than 52
                //     {field:"height", type:"<", value:142}, //and by height less than 142
                // ]
                // This is currently unused, as our searchPhrase requires a different format
                // on the backend.

                if (this.searchPhrase !== "") {
                    params['searchPhrase'] = this.searchPhrase;
                }

                if (params?.sort ?? false) {
                    // map tabulator sort mechanism
                    let sort = {};
                    params.sort.forEach((s) => {
                        sort[s.field] = s.dir;
                    });

                    params.sort = sort;
                }

                // handle rowCount
                params['rowCount'] = this.curRowCount === true ? -1 : this.curRowCount;

                delete params.filter;

                params = this.options.requestHandler(params);

                return new Promise((resolve, reject) => {
                    config = {
                        ...this.options.ajaxConfig,
                        url: url,
                        data: JSON.stringify(params),
                        success: (response) => {
                            if (typeof (response) === "string") {
                                response = $.parseJSON(response);
                            }

                            response = this.options.responseHandler(response);
                            resolve(response);
                        },
                        error: (jqXHR, textStatus, errorThrown) => {
                            reject();
                        }
                    }

                    $.ajax(config);
                });
            },

            /* server-side sorting logic (see ajaxRequestFunc()) */
            sortMode: "remote",
            headerSortElement: (column, dir) => {
                switch (dir) {
                    case "asc":
                    case "desc":
                        return '<div class="tabulator-arrow"></div>';
                        break;
                    default:
                        return "";
                        break;
                }
            }
        };
    }

    /**
     * set current page and scroll to row
     * @param {*} id datakey option value
     */
    setPageByRowId(id) {
        let page = parseInt((id / this.curRowCount) + 1);

        this.searchPhrase = "";
        $(`#${this.id}-search-field`).val("");
        this.table.setPage(page).then(() => {
            this.table.scrollToRow(id).then(() => {
                const $el = $(this.table.getRow(id).getElement());
                $el.addClass('highlight-bg');
                setTimeout(() => $el.removeClass('highlight-bg'), 800);
            })
        });
    }

    /**
     * @param {boolean} inplace keep current page selection 
     */
    _reload(inplace=false) {
        let page = this.table.getPage();

        // both calls trigger an ajax request
        if (inplace) {
            this.table.setPage(page);
        } else {
            this.table.replaceData();
        }

        this._syncTableHeight();
    }

    /**
    *  register commands
    */
    _getCommands() {
        let result = {
            "add": {
                method: this.command_add.bind(this),
                requires: ['get', 'set'],
                sequence: 100
            },
            "edit": {
                method: this.command_edit.bind(this),
                classname: 'fa fa-fw fa-pencil',
                requires: ['get', 'set'],
                sequence: 100
            },
            "delete": {
                method: this.command_delete.bind(this),
                classname: 'fa fa-fw fa-trash-o',
                requires: ['del'],
                sequence: 500
            },
            "copy": {
                method: this.command_copy.bind(this),
                classname: 'fa fa-fw fa-clone',
                requires: ['get', 'set'],
                sequence: 200
            },
            "info": {
                method: this.command_info.bind(this),
                classname: 'fa fa-fw fa-info-circle',
                requires: ['info'],
                sequence: 500
            },
            "toggle": {
                method: this.command_toggle.bind(this),
                requires: ['toggle'],
                sequence: 100
            },
            "delete-selected": {
                method: this.command_delete_selected.bind(this),
                requires: ['del'],
                sequence: 100
            }
        };
        // register additional commands
        $.each(this.options.commands, (k, v) => {
            if (result[k] === undefined) {
                result[k] = { requires: [], sequence: 1 };
            }
            $.each(v, (ck, cv) => {
                result[k][ck] = cv;
            });
        });
        return result;
    }

    /**
     * Return the generic formatters available to every template. If a template
     * overrides one of these formatters by providing their own function, the compatibility
     * layer will already have converted the function signature
     */
    _internalFormatters() {
        return {
            default: (cell, formatterParams, onRendered) => {
                /**
                 * default formatter: called for every cell where no formatter is explicitly defined.
                 * No sanitization is performed
                 */
                return cell.getValue();
            },
            commands: (cell, formatterParams, onRendered) => {
                let html = [];
                // sort commands by sequence
                let commands = this._getCommands();
                let commandlist = Array();
                Object.keys(commands).map(function (k) {
                    let item = commands[k];
                    item.name = k;
                    commandlist.push(item)
                });
                commandlist = commandlist.sort(function (a, b) {
                    return (a.sequence > b.sequence) ? 1 : ((b.sequence > a.sequence) ? -1 : 0);
                }
                );
                let rowid = this.options.datakey !== undefined ? this.options.datakey : 'uuid';
                commandlist.map((command) => {
                    let has_option = command.classname !== undefined;
                    let option_title_str = command.title !== undefined ? " title=\"" + command.title + "\"" : "";
                    for (let i = 0; i < command.requires.length; i++) {
                        if (!(command.requires[i] in this.crud)) {
                            has_option = false;
                        }
                    }

                    if (has_option) {
                        html.push("<button type=\"button\" " + option_title_str +
                            " class=\"btn btn-xs btn-default bootgrid-tooltip command-" + command.name +
                            "\" data-row-id=\"" + cell.getData()[rowid] + "\">" +
                            "<span class=\"" + command.classname + "\"></span></button>"
                        );
                    }
                });
                return html.join('\n');
            },
            commandsWithInfo: function (cell, formatterParams, onRendered) {
                return '<button type="button" class="btn btn-xs btn-default command-info bootgrid-tooltip" data-row-id="' + cell.getData()[this.options.datakey] + '"><span class="fa fa-fw fa-info-circle"></span></button> ' +
                    '<button type="button" class="btn btn-xs btn-default command-edit bootgrid-tooltip" data-row-id="' + cell.getData()[this.options.datakey] + '"><span class="fa fa-fw fa-pencil"></span></button>' +
                    '<button type="button" class="btn btn-xs btn-default command-copy bootgrid-tooltip" data-row-id="' + cell.getData()[this.options.datakey] + '"><span class="fa fa-fw fa-clone"></span></button>' +
                    '<button type="button" class="btn btn-xs btn-default command-delete bootgrid-tooltip" data-row-id="' + cell.getData()[this.options.datakey] + '"><span class="fa fa-fw fa-trash-o"></span></button>';
            },
            rowtoggle: function (cell, formatterParams, onRendered) {
                if (parseInt(cell.getValue(), 2) === 1) {
                    return '<span style="cursor: pointer;" class="fa fa-fw fa-check-square-o command-toggle bootgrid-tooltip" data-value="1" data-row-id="' + cell.getData()[this.options.datakey] + '"></span>';
                } else {
                    return '<span style="cursor: pointer;" class="fa fa-fw fa-square-o command-toggle bootgrid-tooltip" data-value="0" data-row-id="' + cell.getData()[this.options.datakey] + '"></span>';
                }
            },
            boolean: function (cell, formatterParams) {
                if (parseInt(cell.getValue(), 2) === 1) {
                    return "<span class=\"fa fa-fw fa-check\" data-value=\"1\" data-row-id=\"" + cell.getData()[this.options.datakey] + "\"></span>";
                } else {
                    return "<span class=\"fa fa-fw fa-times\" data-value=\"0\" data-row-id=\"" + cell.getData()[this.options.datakey] + "\"></span>";
                }
            },
            bytes: function (cell, formatterParams) {
                if (cell.getValue() && cell.getValue() > 0) {
                    return byteFormat(cell.getValue(), 2);
                }
                return '';
            },
            statusled: function (cell, formatterParams) {
                if (cell.getValue() && cell.getValue() == 'red') {
                    return "<span class=\"fa fa-fw fa-square text-danger\"></span>";
                } else if (cell.getValue() && cell.getValue() == 'green') {
                    return "<span class=\"fa fa-fw fa-square text-success\"></span>";
                } else {
                    return "<span class=\"fa fa-fw fa-square text-muted\"></span>";
                }
            },
            datetime: function(cell, formatterParams, onRendered) {
                return cell.getValue() ? moment(parseInt(cell.getValue())*1000).format("lll") : "";
            },
        }
    }

    show_edit_dialog(event, endpoint) {
        return new Promise((resolve, rejects) => {
            let editDlg = this.$compatElement.attr('data-editDialog');
            let urlMap = {};
            let server_params = this.options.requestHandler({});
    
            urlMap['frm_' + editDlg] = endpoint;
            mapDataToFormUI(urlMap, server_params).done((payload) => {
                // update selectors
                formatTokenizersUI();
                $('.selectpicker').selectpicker('refresh');
                // clear validation errors (if any)
                clearFormValidation('frm_' + editDlg);
                let target = $('#' + editDlg);
                if (target.hasClass('modal')) {
                    // show dialog and hook draggable event on first show
                    target.modal({ backdrop: 'static', keyboard: false });
                    if (!target.hasClass('modal_draggable')) {
                        target.addClass('modal_draggable');
                        let height = 0, width = 0, ypos = 0, xpos = 0;
                        let top_boundary = parseInt($("section.page-content-main").css('padding-top'))
                            + parseInt($("main.page-content").css('padding-top'))
                            - parseInt($("div.modal-dialog").css('margin-top'));
                        let this_header = target.find('.modal-header');
                        this_header.css("cursor", "move");
                        this_header.on('mousedown', function (e) {
                            this_header.addClass("drag");
                            height = target.outerHeight();
                            width = target.outerWidth();
                            ypos = target.offset().top + height - e.pageY;
                            xpos = target.offset().left + width - e.pageX;
                        });
                        $(document.body).on('mousemove', function (e) {
                            let itop = e.pageY + ypos - height;
                            let ileft = e.pageX + xpos - width;
                            if (this_header.hasClass("drag") && itop >= top_boundary) {
                                target.offset({ top: itop, left: ileft });
                            }
                        }).on('mouseup mouseleave', function (e) {
                            this_header.removeClass("drag");
                        });
                    } else {
                        // reset to starting position (remove drag distance)
                        target.css('top', '').css('left', '');
                    }
                } else {
                    // when edit dialog isn't a modal, fire click event
                    target.click();
                }
    
                if (this.options.onBeforeRenderDialog) {
                    this.options.onBeforeRenderDialog(payload).done(function () {
                        resolve();
                    });
                } else {
                    resolve();
                }
            });
        });
    }

    _internalSorters() {
        return {
            memsize: (a, b, aRow, bRow, column, dir, sorterParams) => {
                const modifiers = ['', 'K', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y'];

                function parseMemValue(value) {
                    if (typeof value !== 'string') return 0;
            
                    value = value.trim();
            
                    let num = parseFloat(value);
                    let modifier = value.slice(-1).toUpperCase();
            
                    // Check if the last char is actually a unit
                    if (isNaN(modifier)) {
                        for (let exponent = modifiers.length - 1; exponent >= 0; exponent--) {
                            if (modifier === modifiers[exponent]) {
                                return num * Math.pow(1024, exponent);
                            }
                        }
                    }
            
                    // No modifier match (or modifier is part of number), just return number
                    return num;
                }
            
                const aVal = parseMemValue(a);
                const bVal = parseMemValue(b);
            
                return aVal - bVal;
            }
        };
    }

    /**
    * init / clear save button
    */
    init_save_btn() {
        let editDlg = this.$compatElement.attr('data-editDialog');
        let saveDlg = $("#btn_" + editDlg + "_save").unbind('click');
        saveDlg.find('i').removeClass("fa fa-spinner fa-pulse");
        return saveDlg;
    }

    /**
    * add event
    */
    command_add(event) {
        event.stopPropagation();
        let editDlg = this.$compatElement.attr('data-editDialog');
        if (editDlg !== undefined) {
            let saveDlg = this.init_save_btn();
            this.show_edit_dialog(event, this.crud.get).then(() => {
                $('#' + editDlg).trigger('opnsense_bootgrid_mapped', ['add']);
                saveDlg.click(function () {
                    if (saveDlg.find('i').hasClass('fa-spinner')) {
                        return;
                    }
                    saveDlg.find('i').addClass("fa fa-spinner fa-pulse");
                    saveFormToEndpoint(this.crud.add, 'frm_' + editDlg, () => {
                        if ($('#' + editDlg).hasClass('modal')) {
                            $("#" + editDlg).modal('hide');
                        } else {
                            $("#" + editDlg).change();
                        }
                        this._reload(true);
                        this.showSaveAlert(event);
                        saveDlg.find('i').removeClass("fa fa-spinner fa-pulse");
                    }, true, function () {
                        saveDlg.find('i').removeClass("fa fa-spinner fa-pulse");
                    });
                });
            });
        } else {
            console.log("[grid] action get or data-editDialog missing")
        }
    }

    /**
    * animate alert when saved
    */
    showSaveAlert(event) {
        let editAlert = this.$compatElement.attr('data-editAlert');
        if (editAlert !== undefined) {
            $("#" + editAlert).slideDown(1000, function () {
                setTimeout(function () {
                    $("#" + editAlert).not(":animated").slideUp(2000);
                }, 2000);
            });
        }
    }

    /**
    * edit event
    */
    command_edit(event, uuid = null) {
        if (uuid === null)
            event.stopPropagation();
        let editDlg = this.$compatElement.attr('data-editDialog');
        if (editDlg !== undefined) {
            if (uuid === null)
                uuid = $(event.currentTarget).data('row-id') ?? '';
            let saveDlg = this.init_save_btn();
            this.show_edit_dialog(event, this.crud.get + uuid).then(() => {
                saveDlg.unbind('click').click(() => {
                    if (saveDlg.find('i').hasClass('fa-spinner')) {
                        return;
                    }
                    saveDlg.find('i').addClass("fa fa-spinner fa-pulse");
                    saveFormToEndpoint(this.crud.set + uuid, 'frm_' + editDlg, () => {
                        if ($('#' + editDlg).hasClass('modal')) {
                            $("#" + editDlg).modal('hide');
                        } else {
                            $("#" + editDlg).change();
                        }
                        this._reload(true);
                        //std_bootgrid_reload(this.$compatElement.attr('id'));
                        this.showSaveAlert(event);
                        saveDlg.find('i').removeClass("fa fa-spinner fa-pulse");
                    }, true, () => {
                        saveDlg.find('i').removeClass("fa fa-spinner fa-pulse");
                    });
                });
                $('#' + editDlg).trigger('opnsense_bootgrid_mapped', ['edit']);
            });
        } else {
            console.log("[grid] action get or data-editDialog missing")
        }
    }

    /**
    * delete event
    */
    command_delete(event) {
        event.stopPropagation();
        let uuid = $(event.currentTarget).data('row-id');
        stdDialogRemoveItem(this.translations.removeWarning, () => {
            ajaxCall(this.crud.del + uuid, {}, (data, status) => {
                // reload grid after delete
                this._reload(true);
                this.showSaveAlert(event);
            });
        });
    }

    /**
    * delete selected event
    */
    command_delete_selected(event) {
        event.stopPropagation();
        stdDialogRemoveItem(this.translations.removeWarning, () => {
            let rows = this.table.getSelectedData();
            console.log(rows);
            if (rows.length > 0) {
                const deferreds = [];
                rows.forEach((row) => {
                    let uuid = row[this.options.datakey];
                    deferreds.push(ajaxCall(this.crud['del'] + uuid, {}, null));
                });
                // refresh after load
                $.when.apply(null, deferreds).done(() => {
                    this._reload(true);
                    this.showSaveAlert(event);
                });
            }
        });
    }

    /**
    * copy event
    */
    command_copy(event) {
        event.stopPropagation();
        const editDlg = this.$compatElement.attr('data-editDialog');
        if (editDlg !== undefined) {
            const uuid = $(event.currentTarget).data('row-id');
            const urlMap = {};
            urlMap['frm_' + editDlg] = this.crud.get + uuid + "?fetchmode=copy";
            mapDataToFormUI(urlMap).done(() => {
                // update selectors
                formatTokenizersUI();
                $('.selectpicker').selectpicker('refresh');
                // clear validation errors (if any)
                clearFormValidation('frm_' + editDlg);

                if ($('#' + editDlg).hasClass('modal')) {
                    // show dialog
                    $('#' + editDlg).modal({ backdrop: 'static', keyboard: false });
                } else {
                    // when edit dialog isn't a modal, fire click event
                    $('#' + editDlg).click();
                }
                // define save action
                let saveDlg = this.init_save_btn();
                saveDlg.click(() => {
                    if (saveDlg.find('i').hasClass('fa-spinner')) {
                        return;
                    }
                    saveDlg.find('i').addClass("fa fa-spinner fa-pulse");
                    saveFormToEndpoint(this.crud['add'], 'frm_' + editDlg, () => {
                        if ($('#' + editDlg).hasClass('modal')) {
                            $("#" + editDlg).modal('hide');
                        } else {
                            $("#" + editDlg).change();
                        }
                        this._reload(true);
                        this.showSaveAlert(event);
                        saveDlg.find('i').removeClass("fa fa-spinner fa-pulse");
                    }, true, function () {
                        saveDlg.find('i').removeClass("fa fa-spinner fa-pulse");
                    });
                });
                $('#' + editDlg).trigger('opnsense_bootgrid_mapped', ['copy']);
            });
        } else {
            console.log("[grid] action get or data-editDialog missing")
        }
    }

    /**
    * info event
    */
    command_info(event) {
        event.stopPropagation();
        const uuid = $(event.currentTarget).data('row-id');
        ajaxGet(this.crud['info'] + uuid, {}, (data, status) => {
            if (status === 'success') {
                const title = data['title'] || "Information";
                const message = data['message'] || "A Message";
                const close = data['close'] || "Close";
                stdDialogInform(title, message, close, undefined, "info");
            }
        });
    }

    /**
    * toggle event
    */
    command_toggle(event) {
        event.stopPropagation();
        const uuid = $(event.currentTarget).data('row-id');
        console.log(uuid);
        $(event.currentTarget).removeClass('fa-check-square-o fa-square-o').addClass("fa-spinner fa-pulse");
        ajaxCall(this.crud['toggle'] + uuid, {}, (data, status) => {
            // reload grid after delete
            this._reload(true);
            this.showSaveAlert(event);
        });
    }

    _debounce(f, delay = 50, ensure = true) {
        // debounce to prevent a flood of calls in a short time
        let lastCall = Number.NEGATIVE_INFINITY;
        let wait;
        let handle;
        return (...args) => {
            wait = lastCall + delay - Date.now();
            clearTimeout(handle);
            if (wait <= 0 || ensure) {
                handle = setTimeout(() => {
                    f(...args);
                    lastCall = Date.now();
                }, wait);
            }
        };
    }

    /**
     * 
     * jQuery.bootgrid backwards compatibility functions
     */
    append(rows) {
        this.table.addData(rows);
    }

    clear(...args) {
        if (this.tableInitialized) {
            this.table.clearData();
        }
    }

    reload(...args) {
        this._reload();
    }

    getRowCount(...args) {
        return this.curRowCount;
    }

    getSelectedRows() {
        return this.table.getSelectedData().map(row => row[this.options.datakey]);
    }

    getCurrentRows(...args) {
        return this.table.getData();
    }

    getTotalRowCount() {
        return this.table.getDataCount();
    }

    getCurrentPage(...args) {
        return this.table.getPage();
    }

    destroy(...args) {
        this._destroyTable();
    }

    setColumns(columns) {
        this.table.getColumns().forEach((col) => {
            const def = col.getDefinition();
            if (columns.includes(def.field)) {
                col.show();
            }
        })
    }

    unsetColumns(columns) {
        this.table.getColumns().forEach((col) => {
            const def = col.getDefinition();
            if (columns.includes(def.field)) {
                col.hide();
            }
        })
    }

    select(datakeys) {
        datakeys.forEach((datakey) => {
            this.table.selectRow(datakey);
        })
    }

    getSearchPhrase() {
        return this.searchPhrase;
    }
}
