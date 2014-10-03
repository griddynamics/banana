/*
  ## Multivalue Terms (based on Terms)

  ### Parameters
  * style :: A hash of css styles
  * size :: top N
  * arrangement :: How should I arrange the query results? 'horizontal' or 'vertical'
  * chart :: Show a chart? 'none', 'bar', 'pie'
  * donut :: Only applies to 'pie' charts. Punches a hole in the chart for some reason
  * tilt :: Only 'pie' charts. Janky 3D effect. Looks terrible 90% of the time.
  * lables :: Only 'pie' charts. Labels on the pie?
*/
define([
  'angular',
  'app',
  'underscore',
  'jquery',
  'kbn'
],
function (angular, app, _, $, kbn) {
  'use strict';

  var DEBUG = false; // DEBUG mode
  var componentItemType = 'terms';
  var componentIdCounter = 0; // ID counter for instances on that module

  var module = angular.module('kibana.panels.terms_multiselect', []);
  app.useModule(module);

  module.controller('terms_multiselect', function($scope, querySrv, dashboard, filterSrv) {
    $scope.panelMeta = {
      modals : [
        {
          description: "Inspect",
          icon: "icon-info-sign",
          partial: "app/partials/inspector.html",
          show: $scope.panel.spyable
        }
      ],
      editorTabs : [
        {title:'Queries', src:'app/partials/querySelect.html'}
      ],
      status  : "Under development",
      description : "Displays the results of a Solr multisilect facet as a pie chart, bar chart, or a table. Newly added functionality displays min/max/mean/sum of a stats field, faceted by the Solr facet field, again as a pie chart, bar chart or a table."
    };

    // Set and populate defaults
    var _d = {
      queries     : {
        mode        : 'all',
        ids         : [],
        query       : '*:*',
        custom      : ''
      },
      mode    : 'count', // mode to tell which number will be used to plot the chart.
      field   : '',
      stats_field : '',
      decimal_points : 0, // The number of digits after the decimal point
      exclude : [],
      missing : true,
      other   : true,
      size    : 10,
      // order   : 'count',
      order   : 'descending',
      style   : { "font-size": '10pt'},
      donut   : false,
      tilt    : false,
      labels  : true,
      arrangement : 'horizontal',
      chart       : 'bar',
      counter_pos : 'above',
      spyable     : true,
    };
    _.defaults($scope.panel,_d);

    $scope.init = function () {
      $scope.hits = 0;
      $scope.componentId = ++componentIdCounter;

      $scope.$on('refresh',function(){
        $scope.get_data();
      });
      $scope.get_data();
    };

    $scope.get_data = function() {
      // Make sure we have everything for the request to complete
      if(dashboard.indices.length === 0) {
        return;
      }

      $scope.panelMeta.loading = true;
      var request,
        results,
        boolQuery;

      //Solr
      $scope.sjs.client.server(dashboard.current.solr.server + dashboard.current.solr.core_name);

      if (DEBUG) { console.debug('terms:\n\tdashboard',dashboard,'\n\tquerySrv=',querySrv,'\n\tfilterSrv=',filterSrv); }

      request = $scope.sjs.Request().indices(dashboard.indices);

      $scope.panel.queries.ids = querySrv.idsByMode($scope.panel.queries);
      // This could probably be changed to a BoolFilter
      boolQuery = $scope.sjs.BoolQuery();
      _.each($scope.panel.queries.ids,function(id) {
        boolQuery = boolQuery.should(querySrv.getEjsObj(id));
      });

      // Terms mode
      request = request
        .facet($scope.sjs.TermsFacet('terms')
          .field($scope.panel.field)
          .size($scope.panel.size)
          .order($scope.panel.order)
          .exclude($scope.panel.exclude)
          .facetFilter($scope.sjs.QueryFilter(
            $scope.sjs.FilteredQuery(
              boolQuery,
              filterSrv.getBoolFilter(filterSrv.ids)
              )))).size(0);

      // Populate the inspector panel
      $scope.inspector = angular.toJson(JSON.parse(request.toString()),true);

      // Build Solr query
      var fq = '&' + filterSrv.getSolrFq();
      // var start_time = filterSrv.getStartTime();
      // var end_time = filterSrv.getEndTime();
      var wt_json = '&wt=json';
      var rows_limit = '&rows=0'; // for terms, we do not need the actual response doc, so set rows=0
      // var facet_gap = '%2B1DAY';
      var facet = '';

      if ($scope.panel.mode === 'count') {
        facet = '&facet=true&facet.field={!ex=' + $scope.getSolrTag() + '}' + $scope.panel.field + '&facet.limit=' + $scope.panel.size;
      } else {
        // if mode != 'count' then we need to use stats query
        // stats does not support something like facet.limit, so we have to sort and limit the results manually.
        facet = '&stats=true&stats.facet={!ex=' + $scope.getSolrTag() + '}' + $scope.panel.field + '&stats.field=' + $scope.panel.stats_field;
      }

      // Set the panel's query
      $scope.panel.queries.query = querySrv.getQuery(0) + wt_json + rows_limit + fq + facet;

      // Set the additional custom query
      if ($scope.panel.queries.custom != null) {
        request = request.setQuery($scope.panel.queries.query + $scope.panel.queries.custom);
      } else {
        request = request.setQuery($scope.panel.queries.query);
      }

      results = request.doSearch();

      // Populate scope when we have results
      results.then(function(results) {
        if (DEBUG) { console.debug('terms: results=',results); }

        var k = 0;
        $scope.panelMeta.loading = false;
        $scope.hits = results.response.numFound;

        $scope.data = [];

        if ($scope.panel.mode === 'count') {
          // In count mode, the y-axis min should be zero because count value cannot be negative.
          $scope.yaxis_min = 0;
          _.each(results.facet_counts.facet_fields, function(v) {
            for (var i = 0; i < v.length; i++) {
              var term = v[i];
              i++;
              var count = v[i];
              // if count = 0, do not add it to the chart, just skip it
              if (count == 0) continue;
              var isSelected = !!$scope.getFilter(term); 
              var slice = { label : term, data : [[k,count]], actions: true, isSelected: isSelected};
              $scope.data.push(slice);
            };
          });
        } else {
          // In stats mode, set y-axis min to null so jquery.flot will set the scale automatically.
          $scope.yaxis_min = null;
          _.each(results.stats.stats_fields[$scope.panel.stats_field].facets[$scope.panel.field], function(stats_obj,facet_field) {
            var slice = { label:facet_field, data:[[k,stats_obj[$scope.panel.mode]]], actions: true };
            $scope.data.push(slice);
          });
        }

        // Sort the results
        if ($scope.panel.order == 'descending') {
          $scope.data = _.sortBy($scope.data, function(d) {return -d.data[0][1];});
        } else {
          $scope.data = _.sortBy($scope.data, function(d) {return d.data[0][1];});
        }
        // Slice it according to panel.size, and then set the x-axis values with k.
        $scope.data = $scope.data.slice(0,$scope.panel.size);
        _.each($scope.data, function(v) {
          v.data[0][0] = k;
          k++;
        });

//        $scope.data.push({label:'Missing field',
//          // data:[[k,results.facets.terms.missing]],meta:"missing",color:'#aaa',opacity:0});
//          // TODO: Hard coded to 0 for now. Solr faceting does not provide 'missing' value.
//          data:[[k,0]],meta:"missing",color:'#aaa',opacity:0});
//        $scope.data.push({label:'Other values',
//          // data:[[k+1,results.facets.terms.other]],meta:"other",color:'#444'});
//          // TODO: Hard coded to 0 for now. Solr faceting does not provide 'other' value. 
//          data:[[k+1,0]],meta:"other",color:'#444'});

        if (DEBUG) { console.debug('terms: $scope.data = ',$scope.data); }

        $scope.$emit('render');
      });
    };

    $scope.getSolrTag = function() {
      return componentItemType + '_' + $scope.panel.field + '_' + $scope.componentId;
    };

    $scope.getFilter = function(fieldValue) {
      var foundFilters = filterSrv.filtersByTypeAndFieldAndValue(componentItemType, $scope.panel.field, fieldValue);
      return (foundFilters && foundFilters.length > 0)? foundFilters[0] : null;
    };

    $scope.search_multiselect = function() {
      _.each($scope.data, function(v) {
        var isFilterPresent = !!$scope.getFilter(v.label);
        if (v.isSelected) {
          if (!isFilterPresent) {
            filterSrv.set({type: componentItemType,field:$scope.panel.field,value:v.label, mandate:'must', solrTag: $scope.getSolrTag()});
          }
        } else {
          if (isFilterPresent) { // remove if present
            filterSrv.removeByTypeAndFieldAndValue(componentItemType, $scope.panel.field, v.label);
          }
        }
      });
      dashboard.refresh();
    };

/*    $scope.toggle_multiselect = function(term) {
      var defaultType = 'terms';
      if(_.isUndefined(term.meta)) {
        filterSrv.set({type:defaultType,field:$scope.panel.field,value:term.label, mandate:'must', solrTag: $scope.getSolrTag()});
      } else if(term.meta === 'missing') {
        filterSrv.set({type:'exists',field:$scope.panel.field, mandate:'mustNot', solrTag: $scope.getSolrTag()});
      } else if(term.meta === defaultType) { // have it - then remove (un-checked box)
        filterSrv.removeByTypeAndField(defaultType, $scope.panel.field);
      }
    };*/

//    $scope.build_search = function(term,negate) {
//      if(_.isUndefined(term.meta)) {
//        filterSrv.set({type:'terms',field:$scope.panel.field,value:term.label,
//          mandate:(negate ? 'mustNot':'must')});
//      } else if(term.meta === 'missing') {
//        filterSrv.set({type:'exists',field:$scope.panel.field,
//          mandate:(negate ? 'must':'mustNot')});
//      } else {
//        return;
//      }
//      dashboard.refresh();
//    };

    $scope.set_refresh = function (state) {
      $scope.refresh = state;
      // if 'count' mode is selected, set decimal_points to zero automatically.
      if ($scope.panel.mode === 'count') {
        $scope.panel.decimal_points = 0;
      }
    };

    $scope.close_edit = function() {
      if($scope.refresh) {
        $scope.get_data();
      }
      $scope.refresh =  false;
      $scope.$emit('render');
    };

    $scope.showMeta = function(term) {
      if(_.isUndefined(term.meta)) {
        return true;
      }
      if(term.meta === 'other' && !$scope.panel.other) {
        return false;
      }
      if(term.meta === 'missing' && !$scope.panel.missing) {
        return false;
      }
      return true;
    };

  });

  module.directive('termsChart', function(querySrv,dashboard) {
    return {
      restrict: 'A',
      link: function(scope, elem) {

        // Receive render events
        scope.$on('render',function(){
          render_panel();
        });

        // Re-render if the window is resized
        angular.element(window).bind('resize', function(){
          render_panel();
        });

        // Function for rendering panel
        function render_panel() {
          var plot, chartData;

          // IE doesn't work without this
          elem.css({height:scope.panel.height||scope.row.height});

          // Make a clone we can operate on.
          chartData = _.clone(scope.data);
          chartData = scope.panel.missing ? chartData :
            _.without(chartData,_.findWhere(chartData,{meta:'missing'}));
          chartData = scope.panel.other ? chartData :
          _.without(chartData,_.findWhere(chartData,{meta:'other'}));

          if (DEBUG) { console.debug('terms: render_panel() => chartData = ',chartData); }

          // Populate element.
          require(['jquery.flot.pie'], function(){
            // Populate element
            try {
              // Add plot to scope so we can build out own legend
              if(scope.panel.chart === 'bar') {
                plot = $.plot(elem, chartData, {
                  legend: { show: false },
                  series: {
                    lines:  { show: false, },
                    bars:   { show: true,  fill: 1, barWidth: 0.8, horizontal: false },
                    shadowSize: 1
                  },
                  // yaxis: { show: true, min: 0, color: "#c8c8c8" },
                  yaxis: { show: true, min: scope.yaxis_min, color: "#c8c8c8" },
                  xaxis: { show: false },
                  grid: {
                    borderWidth: 0,
                    borderColor: '#eee',
                    color: "#eee",
                    hoverable: true,
                    clickable: true
                  },
                  colors: querySrv.colors
                });
              }
              if(scope.panel.chart === 'pie') {

                var labelFormat = function(label, series){
                  return '<div ng-click="build_search(panel.field,\''+label+'\')'+
                    ' "style="font-size:8pt;text-align:center;padding:2px;color:white;">'+
                    label+'<br/>'+Math.round(series.percent)+'%</div>';
                };

                plot = $.plot(elem, chartData, {
                  legend: { show: false },
                  series: {
                    pie: {
                      innerRadius: scope.panel.donut ? 0.4 : 0,
                      tilt: scope.panel.tilt ? 0.45 : 1,
                      radius: 1,
                      show: true,
                      combine: {
                        color: '#999',
                        label: 'The Rest'
                      },
                      stroke: {
                        width: 0
                      },
                      label: {
                        show: scope.panel.labels,
                        radius: 2/3,
                        formatter: labelFormat,
                        threshold: 0.1
                      }
                    }
                  },
                  //grid: { hoverable: true, clickable: true },
                  grid:   { hoverable: true, clickable: true },
                  colors: querySrv.colors
                });
              }

              // Populate legend
              if(elem.is(":visible")){
                setTimeout(function(){
                  scope.legend = plot.getData();
                  if(!scope.$$phase) {
                    scope.$apply();
                  }
                });
              }

            } catch(e) {
              elem.text(e);
            }
          });
        }

        elem.bind("plotclick", function (event, pos, object) {
          if(object) {
            scope.build_search(scope.data[object.seriesIndex]);
          }
        });

        var $tooltip = $('<div>');
        elem.bind("plothover", function (event, pos, item) {
          if (item) {
            // if (DEBUG) { console.debug('terms: plothover item = ',item); }
            var value = scope.panel.chart === 'bar' ? item.datapoint[1] : item.datapoint[1][0][1];

            // if (scope.panel.mode === 'count') {
            //   value = value.toFixed(0);
            // } else {
            //   value = value.toFixed(scope.panel.decimal_points);
            // }

            $tooltip
              .html(
                kbn.query_color_dot(item.series.color, 20) + ' ' +
                item.series.label + " (" + dashboard.numberWithCommas(value.toFixed(scope.panel.decimal_points)) +")"
              )
              .place_tt(pos.pageX, pos.pageY);
          } else {
            $tooltip.remove();
          }
        });

      }
    };
  });

});